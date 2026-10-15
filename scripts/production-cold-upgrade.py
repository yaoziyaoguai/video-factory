#!/usr/bin/env python3
"""首次旧版升级的宿主证明；入口屏障与共享门禁由各自的正式控制器负责。"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import socket
import sys

spec = importlib.util.spec_from_file_location("production_backup", Path(__file__).with_name("production-backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
Error = backup.BackupError
SHA = re.compile(r"[a-f0-9]{40}")
IMAGE = re.compile(r"sha256:[a-f0-9]{64}")


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def command(argv, description):
    return backup.require_command_success(backup.run_command(argv, description=description), description)


def write_new(target, value):
    with target.open("x", encoding="utf8") as handle:
        os.chmod(target, 0o600)
        json.dump(value, handle, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    backup.fsync_path(target.parent)


def private_json(target):
    info = target.lstat()
    if not target.is_file() or target.is_symlink() or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise Error("冷升级事务文件身份或权限无效")
    return backup.read_json(target, "冷升级事务")


def fingerprint(target):
    if target.is_symlink() or not target.is_dir():
        raise Error("旧 broker 制品根无效")
    result = {}
    for base, directories, files in os.walk(target, followlinks=False):
        base = Path(base)
        for name in directories + files:
            item = base / name
            if item.is_symlink():
                raise Error("旧 broker 制品不能含符号链接")
            if item.is_file():
                result[str(item.relative_to(target))] = backup.sha256_file(item)
    if "dist/main.js" not in result or "dist/broker-server.js" not in result:
        raise Error("旧 broker 制品不完整")
    return hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()


def selected_socket(status):
    values = {}
    texts = [status.get("Environment", "")]
    for item in backup.environment_files(status.get("EnvironmentFiles", "")):
        texts.append(Path(item["source"]).read_text())
    for text in texts:
        for token in shlex.split(text, comments=True):
            if token.startswith("VIDEO_FACTORY_CODEX_SOCKET_PATH="):
                values["socket"] = token.split("=", 1)[1]
    if "socket" not in values:
        raise Error("旧 broker 必须显式配置 socket，冷升级不能猜测入口")
    return str(backup.absolute_path(values["socket"], "broker socket"))


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, filename):
        super().__init__("localhost", timeout=5)
        self.filename = filename

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.filename)


def health(filename, resource="/health"):
    connection = UnixConnection(filename)
    try:
        connection.request("GET", resource)
        response = connection.getresponse()
        raw = response.read(1024 * 1024 + 1)
        if response.status != 200 or len(raw) > 1024 * 1024:
            raise Error("旧 broker 只读健康检查失败")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise Error("旧 broker 健康响应无效")
        return value
    finally:
        connection.close()


def broker_idle(filename, profile=None):
    value = health(filename)
    if value.get("protocolVersion") != "video-factory/codex-bridge-v2" or value.get("active") != 0 or value.get("queued") != 0:
        raise Error("旧 broker 仍有执行/排队任务，或其状态不可核实")
    if profile is not None and value.get("profileId") != profile:
        raise Error("旧 broker 身份与实际配置不符")
    return {key: value.get(key) for key in ("protocolVersion", "profileId", "providerId", "modelId", "storeId", "startedAt")}


def live_brokers(state, units):
    observations = {}
    for unit, expected in state["units"].items():
        current = units.get(unit)
        if current is None:
            raise Error("broker 服务清单改变")
        if expected["active"]:
            if current.get("ActiveState") != "active" or current.get("SubState") != "running" or current.get("MainPID") != expected["pid"]:
                raise Error("原 broker 在冷升级观察期间重启或退出")
            main_socket = expected["socket"]
            observations[unit] = {"default": broker_idle(main_socket, expected["profile"]), "models": {}}
            models = health(main_socket, "/v1/models").get("models")
            if not isinstance(models, list):
                raise Error("旧 broker 模型清单不完整")
            observed = set()
            for model in models:
                if not isinstance(model, dict) or not re.fullmatch(r"m-[a-f0-9]{12}", model.get("id", "")):
                    raise Error("旧 broker 模型身份无效")
                model_id = model["id"]
                if model_id in observed or model.get("socketName") != model_id + ".sock":
                    raise Error("旧 broker 模型 socket 身份冲突")
                observed.add(model_id)
                observations[unit]["models"][model_id] = broker_idle(str(Path(main_socket).parent / model["socketName"]))
            # 同时检查未在 registry 公告中的实际 socket，避免遗漏停用或残留入口。
            actual = {item.name for item in Path(main_socket).parent.iterdir() if item.is_socket()}
            if actual != {Path(main_socket).name} | {item + ".sock" for item in observed}:
                raise Error("旧 broker 存在未覆盖的 socket")
        elif current.get("ActiveState") != "inactive" or current.get("SubState") != "dead" or current.get("MainPID") != "0" or current.get("ControlPID") != "0":
            raise Error("原先退出的 broker 状态改变")
    if set(units) != set(state["units"]):
        raise Error("broker 服务清单改变")
    return observations


def assert_loopback(container):
    ports = container.get("NetworkSettings", {}).get("Ports", {})
    bindings = ports.get("4317/tcp")
    if not isinstance(bindings, list) or not bindings or any(item.get("HostIp") not in ("127.0.0.1", "::1") or item.get("HostPort") != "4317" for item in bindings):
        raise Error("旧 app 端口必须仅经 loopback 暴露")
    if any(value for key, value in ports.items() if key != "4317/tcp"):
        raise Error("旧 app 还有未覆盖的外部端口")


def ingress_closed(state):
    ingress = private_json(Path(state["ingressPath"]))
    if ingress.get("phase") != "closed":
        raise Error("本站入口尚未关闭并排空")
    # 再调用入口控制器检查实际配置和旧 worker；磁盘标记本身不是屏障证明。
    command([state["node"], str(Path(__file__).with_name("production-cold-ingress.mjs")), "status", state["ingressPath"]], "冷升级入口屏障复核")


def original_identity(state, *, same_container=True):
    if Path(state["lastReleaseFile"]).read_text().strip() != state["previousRelease"]:
        raise Error("最后成功版本在冷升级期间改变")
    info = backup.docker_inspect(state["containerName"])
    if info.get("Image") != state["container"]["image"] or same_container and info.get("Id") != state["container"]["id"]:
        raise Error("原 app 制品身份改变")
    if str(Path(state["brokerCurrent"]).resolve(strict=True)) != state["brokerRelease"] or fingerprint(Path(state["brokerRelease"])) != state["brokerDigest"]:
        raise Error("原 broker 制品身份改变")
    return info


def stable_roles(state, *, stopped=False):
    roles, _, units = backup.resolve_sources(state["containerName"], require_stopped=stopped)
    if roles != state["roles"]:
        raise Error("业务持久根或执行身份在冷升级期间改变")
    return roles, units


def strict_report(state, roles):
    retired = {unit for unit, status in state["units"].items() if not status["active"]}
    # 只对原本已退役且实际退出的服务接受旧格式未知结果；不能用本次 stop 把活动任务变成旧数据。
    for unit in retired:
        backup.assert_broker_stopped(unit, backup.inspect_unit(unit))
    return backup.verifier_report(state["candidateImage"], roles, require_locally_idle=True,
                                  stopped_units=retired, allow_legacy=True)


def prepare(args):
    if not SHA.fullmatch(args.previous_release or "") or not SHA.fullmatch(args.candidate_release or "") or args.previous_release == args.candidate_release:
        raise Error("冷升级要求不同的准确原版本和候选 SHA")
    if args.state.exists():
        raise Error("冷升级事务已经存在")
    info = backup.docker_inspect(args.container)
    if info.get("State", {}).get("Running") is not True or not IMAGE.fullmatch(info.get("Image", "")) or not re.fullmatch(r"[a-f0-9]{64}", info.get("Id", "")):
        raise Error("冷升级要求身份明确且正在运行的原 app")
    assert_loopback(info)
    if args.last_release.read_text().strip() != args.previous_release:
        raise Error("冷升级预期旧 SHA 与最后成功发布不符")
    marker = [item.split("=", 1)[1] for item in info.get("Config", {}).get("Env", []) if item.startswith("VIDEO_FACTORY_RELEASE_SHA=")]
    if marker and marker[-1] != args.previous_release:
        raise Error("原 app 版本回显与最后成功发布不符")
    broker_release = args.broker_current.resolve(strict=True)
    if broker_release.parent != args.broker_current.parent / "releases":
        raise Error("原 broker release 不在受控制品目录")
    roles, _, units = backup.resolve_sources(args.container, require_stopped=False)
    statuses = {}
    for unit, status in units.items():
        active = status.get("ActiveState") == "active" and status.get("SubState") == "running"
        if active:
            if unit not in ("vf-codex-broker.service", "vf-deepseek-codex-broker.service") or not status.get("MainPID", "").isdigit() or int(status["MainPID"]) < 1 or status.get("ControlPID") != "0":
                raise Error("存在冷升级不能恢复的活动 broker")
            role = next(item for item in roles if item["role"] == "broker-workspace" and item["unit"] == unit)
            statuses[unit] = {"active": True, "pid": status["MainPID"], "profile": role["profile"], "socket": selected_socket(status)}
        else:
            if status.get("ActiveState") != "inactive" or status.get("SubState") != "dead" or status.get("MainPID") != "0" or status.get("ControlPID") != "0":
                raise Error("broker 原退出状态无法证明")
            statuses[unit] = {"active": False, "pid": "0"}
    if not statuses.get("vf-deepseek-codex-broker.service", {}).get("active"):
        raise Error("首次维护协议升级要求现有 DeepSeek 服务正在运行")
    state = {"version": 1, "statePath": str(args.state), "previousRelease": args.previous_release, "candidateRelease": args.candidate_release,
             "containerName": args.container, "container": {"id": info["Id"], "image": info["Image"]},
             "candidateImage": backup.docker_inspect(args.image)["Id"], "lastReleaseFile": str(args.last_release), "brokerCurrent": str(args.broker_current),
             "brokerRelease": str(broker_release), "brokerDigest": fingerprint(broker_release), "roles": roles, "units": statuses,
             "ingressPath": str(args.ingress), "node": args.node, "maintenanceDirectory": str(args.maintenance_directory),
             "candidateEndpoints": ["http://127.0.0.1:4317/api/health", "unix:" + statuses["vf-deepseek-codex-broker.service"]["socket"]],
             "preparedAt": utc_now()}
    live_brokers(state, units)
    strict_report(state, roles)
    write_new(args.state, state)


def idle(state, *, app_stopped=False):
    ingress_closed(state)
    info = original_identity(state)
    if app_stopped:
        check_app_stopped(info)
    elif info.get("State", {}).get("Running") is not True:
        raise Error("原 app 已意外退出")
    roles, units = stable_roles(state)
    before = live_brokers(state, units)
    strict_report(state, roles)
    _, after_units = stable_roles(state)
    if before != live_brokers(state, after_units):
        raise Error("旧 broker 实例在闲置检查期间改变")


def check_app_stopped(info):
    state = info.get("State", {})
    if state.get("Running") is not False or state.get("Pid") != 0 or state.get("Restarting") is not False or state.get("Dead") is not False or state.get("Status") not in ("exited", "created"):
        raise Error("app 尚未正常退出")


def protect_stops(state, state_path):
    idle(state, app_stopped=True)
    protections = []
    for unit, old in state["units"].items():
        if not old["active"]:
            continue
        destination = Path("/run/systemd/system") / (unit + ".d") / "99-video-factory-cold-stop.conf"
        protections.append({"unit": unit, "path": str(destination), "text": "[Service]\nTimeoutStopSec=infinity\nSendSIGKILL=no\n"})
    for item in protections:
        target = Path(item["path"])
        if target.exists() or target.is_symlink() or target.parent.is_symlink():
            raise Error("本次正常停止保护路径已被占用")
    write_new(state_path.with_suffix(".stop-protection.json"), {"protections": protections})
    for item in protections:
        target = Path(item["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("x") as handle:
            handle.write(item["text"])
        target.chmod(0o644)
    command(["systemctl", "daemon-reload"], "正常停止保护加载")
    for item in protections:
        values = dict(line.split("=", 1) for line in command(["systemctl", "show", item["unit"], "--property=TimeoutStopUSec,SendSIGKILL", "--no-pager"], "正常停止保护核验").splitlines() if "=" in line)
        if values.get("TimeoutStopUSec") != "infinity" or values.get("SendSIGKILL") != "no":
            raise Error("无法保证 broker 正常停止而不超时强杀")
    # 保护生效后再次检查，不能把旧 broker 内部 5s shutdown timeout 当作排空证明。
    idle(state, app_stopped=True)
    for item in protections:
        command(["systemctl", "stop", item["unit"]], "旧 broker 正常停止")
    backup.check_writers_stopped(state["containerName"], Path(state["maintenanceDirectory"]))


def cleanup_protections(state_path):
    target = state_path.with_suffix(".stop-protection.json")
    if not target.exists():
        return
    for item in private_json(target)["protections"]:
        file = Path(item["path"])
        if file.exists():
            if file.is_symlink() or file.read_text() != item["text"]:
                raise Error("停止保护已被其他操作修改")
            file.unlink()
    command(["systemctl", "daemon-reload"], "正常停止保护恢复")


def evidence(state, output, *, restored=False):
    ingress_closed(state)
    info = original_identity(state, same_container=not restored)
    roles, units = stable_roles(state, stopped=not restored)
    if restored:
        stopped = private_json(Path(state["statePath"]).with_suffix(".rollback-stopped.json"))
        if stopped.get("candidateRelease") != state["candidateRelease"] or stopped.get("allWritersStopped") is not True:
            raise Error("候选写者退出证明缺失")
        if info.get("State", {}).get("Running") is not True:
            raise Error("原 app 尚未恢复运行")
        # 恢复允许正常的新 PID，但服务、制品和持久身份仍必须与本次原记录一致。
        resumed = {**state, "units": {unit: {**entry, "pid": units[unit]["MainPID"]} for unit, entry in state["units"].items()}}
        live_brokers(resumed, units)
    report = strict_report(state, roles)
    value = {"kind": "cold-abort" if restored else "cold-upgrade", "bootstrap": False,
             "previousRelease": state["previousRelease"], "candidateRelease": state["candidateRelease"],
             "container": {"id": info["Id"], "image": info["Image"]}, "brokerRelease": state["brokerRelease"],
             "ingress": {"closed": True, "drained": True, "statePath": state["ingressPath"]},
             "integrity": {"complete": True, "quiescent": True}, "observedAt": utc_now(),
             "candidateEndpoints": state["candidateEndpoints"],
             "sourceReportSha256": hashlib.sha256(json.dumps(report, sort_keys=True).encode()).hexdigest()}
    if restored:
        value.update(writersRestored=True, candidateWritersStopped=True)
    else:
        value["writersStopped"] = True
    write_new(output, value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "idle", "app-stopped", "stop-brokers", "stopped", "rollback-stopped", "restored", "cleanup"))
    parser.add_argument("state", type=Path)
    parser.add_argument("--container", default="video_factory_prod")
    parser.add_argument("--image", default="video-factory:candidate")
    parser.add_argument("--previous-release")
    parser.add_argument("--candidate-release")
    parser.add_argument("--last-release", type=Path)
    parser.add_argument("--broker-current", type=Path)
    parser.add_argument("--maintenance-directory", type=Path)
    parser.add_argument("--ingress", type=Path)
    parser.add_argument("--node")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.command == "prepare":
            prepare(args)
        elif args.command == "cleanup":
            cleanup_protections(args.state)
        else:
            state = private_json(args.state)
            if args.command in ("idle", "app-stopped"):
                idle(state, app_stopped=args.command == "app-stopped")
            elif args.command == "stop-brokers":
                protect_stops(state, args.state)
            elif args.command == "rollback-stopped":
                ingress_closed(state)
                backup.check_writers_stopped(state["containerName"], Path(state["maintenanceDirectory"]))
                write_new(args.state.with_suffix(".rollback-stopped.json"), {"candidateRelease": state["candidateRelease"], "allWritersStopped": True, "observedAt": utc_now()})
            elif args.command in ("stopped", "restored"):
                evidence(state, args.output, restored=args.command == "restored")
        print(json.dumps({"coldUpgrade": args.command, "verified": True}))
        return 0
    except (Error, OSError, ValueError, http.client.HTTPException) as error:
        detail = str(error) if isinstance(error, Error) else type(error).__name__
        print("Cold upgrade failed: " + detail, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
