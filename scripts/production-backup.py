#!/usr/bin/env python3
"""离线 full 备份：v2 冻结屏障、实际持久根、按业务身份隔离回读。

VIDEO_FACTORY_BACKUP_SOURCE_DESCRIPTOR 可指向 version=1 的非秘密配置描述：
{app:{uid,gid,groups}, brokers:[{unit,workspaceRoot,logicalRoot?,envFiles,
uid,gid,groups,profile,codexHome?}]}。envFiles 接受路径或 {source,logical}。
描述只解决冷维护/测试的配置定位，不能代替实际 docker/systemd 退出证明。
默认从源容器和全部已安装、已加载的 broker units 解析；不猜测缺失的根。
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import datetime
import grp
import hashlib
import io
import json
import os
import pwd
import re
import shlex
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path

FORMAT_VERSION = "video-factory/full-backup-v1"
ADMISSION_PROTOCOL = "video-factory/maintenance-admission-v2"
DEFAULT_MAINTENANCE_DIR = "/opt/video-factory/codex-broker/deployment/maintenance"
APP_LOGICAL_ROOT = "/data/factory"
BROKER_UNITS = ("vf-deepseek-codex-broker.service", "vf-codex-broker.service", "vf-zai-codex-broker.service")
SQLITE_SUFFIXES = (".sqlite", ".sqlite3", ".db")
SQLITE_MAGIC = b"SQLite format 3\x00"
SAFE_ENV = {"VIDEO_FACTORY_CODEX_WORKSPACE_ROOT", "VIDEO_FACTORY_CODEX_PROFILE", "CODEX_HOME"}
EXCLUSION_NOTES = [
    {"pattern": "**/cache/", "reason": "可再生缓存"},
    {"pattern": "Unix sockets", "reason": "运行时通信端点"},
    {"pattern": "broker tasks/.owner.lock; runs/<id>/.execution-lease.json[.lock]", "reason": "进程所有权不恢复为活动执行者，原业务 store-id 和请求保持"},
    {"pattern": "codex-home/auth.json", "reason": "独立登录凭据不属于会话数据；不跟随认证符号链接"},
    {"pattern": "SQLite -wal/-shm", "reason": "复制 DB/WAL/SHM 后用 backup API 合并为独立快照"},
]


class BackupError(Exception):
    pass


def log(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def run_command(argv: list[str], *, description: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(argv, check=False, capture_output=True, text=True)
    except OSError as error:
        raise BackupError(f"{description} 不可用 ({error.errno})") from error


def require_command_success(result: subprocess.CompletedProcess[str], description: str) -> str:
    if result.returncode != 0:
        # 子进程输出可能带受限配置，不把它复制到日志。
        raise BackupError(f"{description} 失败 (exit={result.returncode})")
    return result.stdout


def read_json(target: Path, label: str) -> dict:
    try:
        value = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise BackupError(f"{label} 不存在或不可读") from error
    if not isinstance(value, dict):
        raise BackupError(f"{label} 结构无效")
    return value


@contextmanager
def maintenance_lock(directory: Path):
    # 与 Node 协调器共用 mkdir 短锁；绝不按时间猜测并回收他人的锁。
    if not directory.is_dir():
        raise BackupError("维护门禁不存在或不可读")
    lock = directory / ".admission.lock"
    deadline = time.monotonic() + 5
    while True:
        try:
            lock.mkdir(mode=0o2770)
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise BackupError("维护短锁忙，未回收已有锁")
            time.sleep(0.01)
    try:
        lock.chmod(0o2770)
        yield
    finally:
        lock.rmdir()


def assert_frozen_gate(maintenance_dir: Path, expected_owner: str, phase: str, generation: int | None = None) -> dict:
    gate = read_json(maintenance_dir / "gate.json", f"{phase}: 维护门禁")
    if gate.get("state") != "frozen":
        raise BackupError(f"{phase}: 门禁不是 frozen")
    if not expected_owner or gate.get("owner") != expected_owner:
        raise BackupError(f"{phase}: 门禁 owner 不一致")
    number = gate.get("generation")
    if type(number) is not int or not 0 <= number <= 9007199254740991:
        raise BackupError(f"{phase}: 门禁 generation 无效")
    try:
        datetime.datetime.fromisoformat(gate["updatedAt"].replace("Z", "+00:00"))
    except (KeyError, AttributeError, TypeError, ValueError) as error:
        raise BackupError(f"{phase}: 门禁时间无效") from error
    if generation is not None and number != generation:
        raise BackupError(f"{phase}: 门禁 generation 已改变")
    holders = read_json(maintenance_dir / "holders.json", f"{phase}: 全局 holders")
    if holders.get("protocol") != ADMISSION_PROTOCOL or holders.get("holders") != []:
        raise BackupError(f"{phase}: 全局 holders 非空或结构无效")
    return {key: gate[key] for key in ("state", "owner", "generation", "updatedAt")}


def docker_inspect(reference: str) -> dict:
    result = run_command(["docker", "inspect", reference], description="docker inspect")
    if result.returncode != 0:
        raise BackupError("docker inspect 失败：没有可备份的现有部署")
    try:
        values = json.loads(result.stdout)
        if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
            raise ValueError()
        return values[0]
    except ValueError as error:
        raise BackupError("docker inspect 输出不可解析") from error


def unit_name(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9@_.:-]+", value):
        raise BackupError("broker unit 名称无效")
    return value if value.endswith(".service") else value + ".service"


def inspect_unit(unit: str) -> dict[str, str]:
    properties = "Id,LoadState,ActiveState,SubState,MainPID,ControlPID,ControlGroup,User,Group,SupplementaryGroups,Environment,EnvironmentFiles,DynamicUser,ExecStart"
    result = run_command(["systemctl", "show", unit, f"--property={properties}", "--no-pager"], description="systemctl show")
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if (values.get("LoadState") == "not-found" and result.returncode in (0, 4)
            and values.get("ActiveState") == "inactive" and values.get("SubState") == "dead"
            and values.get("MainPID") == "0" and values.get("ControlPID") == "0"
            and values.get("ControlGroup") == ""):
        return values
    if result.returncode != 0 or values.get("LoadState") != "loaded":
        raise BackupError(f"无法核实 broker 服务 {unit} 的配置或退出状态")
    return values


def discover_units(extra: list[str]) -> dict[str, dict[str, str]]:
    required = set(BROKER_UNITS) | {unit_name(item) for item in extra}
    units = set(required)
    for command in ("list-unit-files", "list-units"):
        # systemd 在 glob 无匹配时可能以 exit=1 返回空输出；枚举全部后本地筛选，查询失败仍拒绝。
        result = run_command(["systemctl", command, "--all", "--type=service", "--no-legend", "--no-pager"], description=f"systemctl {command}")
        text = require_command_success(result, "broker unit 枚举")
        for line in text.splitlines():
            words = line.strip().split()
            if words and words[0] == "●":
                words = words[1:]
            if not words:
                continue
            if not words[0].endswith(".service"):
                raise BackupError("broker unit 枚举输出不完整或不可解析")
            if "broker" in words[0]:
                units.add(unit_name(words[0]))
    result = {}
    for unit in sorted(units):
        status = inspect_unit(unit)
        # 同机其他项目也可能叫 broker；只接管本项目的命名或实际运行绑定。
        belongs = unit in required or unit.startswith(("vf-", "video-factory-")) \
            or "VIDEO_FACTORY_CODEX_WORKSPACE_ROOT=" in status.get("Environment", "") \
            or "/etc/video-factory/" in status.get("EnvironmentFiles", "") \
            or "/opt/video-factory/codex-broker/" in status.get("ExecStart", "")
        if belongs:
            result[unit] = status
    return result


def assert_broker_stopped(unit: str, status: dict) -> None:
    if (status.get("ActiveState") not in ("inactive", "failed")
            or status.get("SubState") not in ("dead", "failed")
            or status.get("MainPID") != "0" or status.get("ControlPID") != "0"):
        raise BackupError(f"broker 服务 {unit} 写者未退出或状态未知")
    cgroup = status.get("ControlGroup")
    if cgroup is None:
        raise BackupError(f"broker 服务 {unit} 缺少 cgroup 退出证明")
    if cgroup:
        group_path = Path("/sys/fs/cgroup") / cgroup.lstrip("/")
        if ".." in group_path.parts:
            raise BackupError("cgroup 路径无效")
        if group_path.exists():
            for base, _, names in os.walk(group_path, onerror=lambda error: (_ for _ in ()).throw(error)):
                if "cgroup.procs" not in names:
                    raise BackupError("无法核实 cgroup 进程集合")
                if (Path(base) / "cgroup.procs").read_text().strip():
                    raise BackupError(f"broker 服务 {unit} cgroup 写者未退出")


def check_writers_stopped(container: str, maintenance_dir: Path, units: dict | None = None) -> dict:
    info = docker_inspect(container)
    state = info.get("State", {})
    if (state.get("Running") is not False or state.get("Restarting") is not False
            or state.get("Dead") is not False or type(state.get("Pid")) is not int or state["Pid"] != 0
            or state.get("Status") not in ("exited", "created")):
        raise BackupError("app 容器写者未退出或退出状态未知")
    if not isinstance(info.get("Image"), str) or not info["Image"]:
        raise BackupError("源 image 身份缺失")
    units = units if units is not None else discover_units([])
    stopped = []
    for unit, status in units.items():
        if status.get("LoadState") == "not-found":
            continue
        assert_broker_stopped(unit, status)
        stopped.append(unit)
    return {"container": container, "containerRunning": False, "image": info["Image"],
            "brokerUnits": stopped, "maintenanceDirectory": str(maintenance_dir)}


def absolute_path(value: object, label: str) -> Path:
    if not isinstance(value, str) or not value or any(c in value for c in ("\n", "\r", "\x00", ":", "%", "$")):
        raise BackupError(f"{label} 路径无效或含未解析展开")
    target = Path(value)
    if not target.is_absolute() or ".." in target.parts or target == Path("/"):
        raise BackupError(f"{label} 必须是明确的绝对路径")
    return target


def resolve_app_root(container: str, override: str | None) -> tuple[Path, str]:
    if override:
        root = absolute_path(override, "app")
        if not root.is_dir():
            raise BackupError("app 工作根不存在")
        return root, "explicit-override"
    info = docker_inspect(container)
    for mount in info.get("Mounts", []):
        if mount.get("Destination") != APP_LOGICAL_ROOT:
            continue
        source = docker_inspect(mount["Name"]).get("Mountpoint") if mount.get("Name") else mount.get("Source")
        root = absolute_path(source, "app mount")
        if not root.is_dir():
            raise BackupError("app 工作根不存在")
        return root, "container-mount"
    raise BackupError("源容器没有 /data/factory 工作挂载")


def identity(value: dict) -> dict:
    if not isinstance(value, dict) or any(type(value.get(key)) is not int or value[key] < 0 for key in ("uid", "gid")):
        raise BackupError("业务 UID/GID 无法解析")
    groups = value.get("groups", [])
    if not isinstance(groups, list) or any(type(item) is not int or item < 0 for item in groups):
        raise BackupError("业务附加组无法解析")
    return {"uid": value["uid"], "gid": value["gid"], "groups": sorted(set(groups))}


def system_identity(status: dict) -> dict:
    if status.get("DynamicUser") != "no" or not status.get("User"):
        raise BackupError("broker 业务身份必须可持久解析")
    try:
        user = status["User"]
        account = pwd.getpwuid(int(user)) if user.isdigit() else pwd.getpwnam(user)
        group = status.get("Group") or str(account.pw_gid)
        gid = int(group) if group.isdigit() else grp.getgrnam(group).gr_gid
        groups = os.getgrouplist(account.pw_name, gid)
        for extra in shlex.split(status.get("SupplementaryGroups", "")):
            groups.append(int(extra) if extra.isdigit() else grp.getgrnam(extra).gr_gid)
        return identity({"uid": account.pw_uid, "gid": gid, "groups": groups})
    except (KeyError, ValueError) as error:
        raise BackupError("broker UID/GID 无法解析") from error


def app_identity(info: dict) -> dict:
    configured = info.get("Config", {}).get("User")
    groups = info.get("HostConfig", {}).get("GroupAdd") or []
    if not isinstance(configured, str) or not configured:
        raise BackupError("源 app 业务身份缺失")
    argv = ["docker", "run", "--rm", "--network", "none", "--read-only", "--user", configured]
    for group in groups:
        argv += ["--group-add", str(group)]
    argv += ["--entrypoint", "node", info["Image"], "--eval",
             "console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups()}))"]
    result = run_command(argv, description="源 app 身份解析")
    try:
        return identity(json.loads(require_command_success(result, "源 app 身份解析")))
    except ValueError as error:
        raise BackupError("源 app 身份不可解析") from error


def environment_files(text: str) -> list[dict]:
    if not text:
        return []
    matches = list(re.finditer(r"(\S+) \(ignore_errors=(yes|no)\)(?:\s+|$)", text))
    if "".join(match.group(0) for match in matches).strip() != text.strip():
        raise BackupError("systemd EnvironmentFiles 无法完整解析；请提供 source descriptor")
    files = []
    for match in matches:
        target = absolute_path(match[1], "EnvironmentFile")
        if not target.exists() and match[2] == "yes":
            continue
        files.append({"source": str(target), "logical": str(target)})
    return files


def selected_environment(text: str) -> dict[str, str]:
    try:
        tokens = shlex.split(text, comments=True)
    except ValueError as error:
        raise BackupError("环境配置不可解析；请提供 source descriptor") from error
    return {key: value for token in tokens if "=" in token for key, value in [token.split("=", 1)] if key in SAFE_ENV}


def configured_broker(unit: str, status: dict) -> dict:
    env = selected_environment(status.get("Environment", ""))
    files = environment_files(status.get("EnvironmentFiles", ""))
    for item in files:
        target = Path(item["source"])
        if not target.is_file():
            raise BackupError("受限模型配置缺失")
        env.update(selected_environment(target.read_text(encoding="utf-8")))
    if "VIDEO_FACTORY_CODEX_WORKSPACE_ROOT" not in env:
        raise BackupError(f"broker {unit} 未显式配置实际 workspace；需要 source descriptor")
    return {"unit": unit, "workspaceRoot": env["VIDEO_FACTORY_CODEX_WORKSPACE_ROOT"], "envFiles": files,
            "profile": env.get("VIDEO_FACTORY_CODEX_PROFILE", "openai"),
            **system_identity(status), **({"codexHome": env["CODEX_HOME"]} if env.get("CODEX_HOME") else {})}


def resolve_sources(container: str, *, require_stopped: bool = True) -> tuple[list[dict], dict, dict]:
    info = docker_inspect(container)
    descriptor_path = os.environ.get("VIDEO_FACTORY_BACKUP_SOURCE_DESCRIPTOR", "")
    descriptor = read_json(Path(descriptor_path), "source descriptor") if descriptor_path else {}
    if descriptor and (descriptor.get("version") != 1 or not isinstance(descriptor.get("brokers"), list)):
        raise BackupError("source descriptor 结构无效")
    supplied = {}
    for entry in descriptor.get("brokers", []):
        if not isinstance(entry, dict) or not isinstance(entry.get("unit"), str):
            raise BackupError("source descriptor broker 无效")
        unit = unit_name(entry["unit"])
        if unit in supplied:
            raise BackupError("source descriptor broker 重复")
        supplied[unit] = entry
    extra = shlex.split(os.environ.get("VIDEO_FACTORY_BROKER_UNITS", "").replace(",", " "))
    units = discover_units(list(supplied) + extra)
    writers = check_writers_stopped(container, Path(os.environ.get("VIDEO_FACTORY_MAINTENANCE_DIR") or DEFAULT_MAINTENANCE_DIR), units) if require_stopped else {
        "image": info.get("Image"), "container": container, "containerRunning": info.get("State", {}).get("Running"),
    }
    app_root, _ = resolve_app_root(container, os.environ.get("VIDEO_FACTORY_APP_WORKSPACE_ROOT", "").strip() or None)
    app_user = identity(descriptor["app"]) if descriptor.get("app") is not None else app_identity(info)
    roles = [{"role": "app-workspace", "source": str(app_root), "logical": APP_LOGICAL_ROOT,
              "archive": "app-workspace", "identity": app_user}]
    brokers = []
    for unit, status in units.items():
        if unit in supplied:
            brokers.append({**supplied[unit], "unit": unit})
        elif status.get("LoadState") != "not-found":
            brokers.append(configured_broker(unit, status))
    if not brokers:
        raise BackupError("无法完整解析任何 broker 持久根")
    for index, broker in enumerate(sorted(brokers, key=lambda item: (item["unit"] != BROKER_UNITS[0], item["unit"]))):
        unit = broker["unit"]
        root = absolute_path(broker.get("workspaceRoot"), "broker workspace")
        logical = str(absolute_path(broker.get("logicalRoot", str(root)), "broker logical root"))
        if index == 0 and os.environ.get("VIDEO_FACTORY_BROKER_WORKSPACE_ROOT"):
            override = Path(os.environ["VIDEO_FACTORY_BROKER_WORKSPACE_ROOT"])
            if not override.is_dir():
                raise BackupError("broker 工作根不存在")
            if override != root:
                raise BackupError("broker override 与实际配置根不一致")
        if not root.is_dir():
            raise BackupError("broker 工作根不存在")
        who = identity(broker)
        prefix = "broker-workspace" if index == 0 else f"brokers/{unit}/workspace"
        role = {"role": "broker-workspace", "unit": unit, "source": str(root), "logical": logical,
                "archive": prefix, "identity": who, "profile": broker.get("profile", "")}
        if role["profile"] not in ("openai", "deepseek", "zai"):
            raise BackupError("broker profile 不可解析")
        roles.append(role)
        files = broker.get("envFiles")
        if not isinstance(files, list) or not files:
            raise BackupError("受限模型配置缺失，或 envFiles 未完整声明")
        for file_index, item in enumerate(files):
            item = {"source": item, "logical": item} if isinstance(item, str) else item
            source = absolute_path(item.get("source"), "broker env")
            destination = str(absolute_path(item.get("logical", str(source)), "broker env logical"))
            if index == 0 and file_index == 0 and os.environ.get("VIDEO_FACTORY_BROKER_ENV_FILE"):
                override = Path(os.environ["VIDEO_FACTORY_BROKER_ENV_FILE"])
                if not override.is_file():
                    raise BackupError("受限模型配置缺失")
                if override != source:
                    raise BackupError("broker env override 与实际配置不一致")
            if not source.is_file():
                raise BackupError("受限模型配置缺失")
            archive = f"broker-config/{source.name}" if index == 0 else f"brokers/{unit}/config/{file_index}-{source.name}"
            roles.append({"role": "broker-config", "unit": unit, "source": str(source), "logical": destination, "archive": archive})
        if broker.get("codexHome"):
            home = absolute_path(broker["codexHome"], "CODEX_HOME")
            if not home.is_dir():
                raise BackupError("CODEX_HOME 会话根不存在")
            role["codexHome"] = str(absolute_path(broker.get("codexHomeLogical", str(home)), "CODEX_HOME logical"))
            roles.append({"role": "codex-home", "unit": unit, "source": str(home), "logical": role["codexHome"],
                          "archive": f"brokers/{unit}/codex-home", "identity": who})
    # 同一目标被两份源覆盖会让恢复验证读错数据，明确拒绝而不选择某一份。
    for index, role in enumerate(roles):
        for previous in roles[:index]:
            a, b = Path(role["logical"]), Path(previous["logical"])
            if a.is_relative_to(b) or b.is_relative_to(a):
                raise BackupError("持久根 logical 映射重叠")
            if role["archive"] == previous["archive"]:
                raise BackupError("持久根 archive 映射重复")
    release_values = [item.split("=", 1)[1] for item in info.get("Config", {}).get("Env", [])
                      if isinstance(item, str) and item.startswith("VIDEO_FACTORY_RELEASE_SHA=")]
    release = release_values[-1] if release_values else None
    if release is not None and not re.fullmatch(r"[a-fA-F0-9]{7,64}", release):
        raise BackupError("源 release SHA 无效")
    return roles, {"image": writers["image"], "releaseSha": release, "container": container, "writers": writers}, units


def excluded(relative: Path, role: str, mode: int) -> bool:
    parts = relative.parts
    if "cache" in parts or stat.S_ISSOCK(mode):
        return True
    if role == "codex-home" and relative.as_posix() == "auth.json":
        return True
    if role == "app-workspace" and len(parts) == 3 and parts[0] == "runs" and parts[2] in (".execution-lease.json", ".execution-lease.json.lock"):
        return True
    if role == "broker-workspace" and parts and parts[-1] == ".owner.lock":
        return (len(parts) == 4 and parts[:2] == (".video-factory", "codex-idempotency")) or (
            len(parts) == 5 and parts[:2] == (".video-factory", "models") and parts[3] == "tasks")
    return False


def discover_files(root: Path, role: str = "app-workspace") -> list[Path]:
    found = []
    def visit(target: Path):
        mode = target.lstat().st_mode
        relative = target.relative_to(root)
        if relative.parts and excluded(relative, role, mode):
            return
        if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise BackupError(f"不支持的持久文件类型：{relative}")
        found.append(target)
        if stat.S_ISDIR(mode):
            for child in sorted(target.iterdir()):
                visit(child)
    visit(root)
    return found


def sha256_file(target: Path) -> str:
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot_sqlite(db: Path, stage_root: Path) -> tuple[Path, dict]:
    stage = stage_root / hashlib.sha256(str(db).encode()).hexdigest()[:24]
    stage.mkdir(parents=True)
    copied = stage / db.name
    shutil.copy2(db, copied)
    sidecars = {}
    for suffix in ("-wal", "-shm"):
        sibling = db.with_name(db.name + suffix)
        if sibling.exists():
            shutil.copy2(sibling, stage / sibling.name)
            sidecars[suffix] = sibling.stat().st_size
    snapshot = stage / "snapshot.sqlite"
    source = sqlite3.connect(copied.as_uri() + "?mode=ro", uri=True)
    target = sqlite3.connect(snapshot)
    try:
        if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise BackupError("SQLite 源库完整性检查失败")
        source.backup(target)
        target.execute("PRAGMA journal_mode=DELETE")
        target.commit()
        if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise BackupError("SQLite 快照完整性检查失败")
    finally:
        source.close()
        target.close()
    apply_metadata(snapshot, metadata(db))
    return snapshot, {"integrity": "ok", "walBytes": sidecars.get("-wal", 0), "shmBytes": sidecars.get("-shm", 0)}


def metadata(target: Path) -> dict:
    value = target.stat()
    return {"uid": value.st_uid, "gid": value.st_gid, "mode": format(stat.S_IMODE(value.st_mode), "04o"), "mtime": int(value.st_mtime)}


def apply_metadata(target: Path, entry: dict) -> None:
    current = target.stat()
    if (current.st_uid, current.st_gid) != (entry["uid"], entry["gid"]):
        os.chown(target, entry["uid"], entry["gid"])
    target.chmod(int(entry["mode"], 8))
    os.utime(target, (entry["mtime"], entry["mtime"]))
    actual = metadata(target)
    if any(actual[key] != entry[key] for key in ("uid", "gid", "mode")):
        raise BackupError("恢复 uid/gid/mode 未能保全")


def add_file(tar: tarfile.TarFile, source: Path, arcname: str, entries: list[dict], metadata_source: Path | None = None) -> None:
    attrs = metadata(metadata_source or source)
    directory = source.is_dir()
    info = tarfile.TarInfo(arcname)
    info.type = tarfile.DIRTYPE if directory else tarfile.REGTYPE
    info.uid, info.gid, info.mode, info.mtime = attrs["uid"], attrs["gid"], int(attrs["mode"], 8), attrs["mtime"]
    info.size = 0 if directory else source.stat().st_size
    entry = {"path": arcname, "type": "directory" if directory else "file", "bytes": info.size, **attrs}
    if directory:
        tar.addfile(info)
    else:
        entry["sha256"] = sha256_file(source)
        with source.open("rb") as handle:
            tar.addfile(info, handle)
    entries.append(entry)


def safe_member(member: tarfile.TarInfo) -> None:
    if member.name.startswith("/") or ".." in Path(member.name).parts or not member.name or not (member.isfile() or member.isdir()):
        raise BackupError("归档包含不安全路径或文件类型")


def verify_archive(partial: Path, files: list[dict]) -> None:
    expected = {entry["path"]: entry for entry in files}
    seen = set()
    embedded = None
    try:
        with tarfile.open(partial, "r:gz") as tar:
            for member in tar:
                safe_member(member)
                if member.name in seen:
                    raise BackupError("归档包含重复成员")
                seen.add(member.name)
                if member.name == "manifest.json":
                    if not member.isfile():
                        raise BackupError("manifest 类型无效")
                    embedded = json.load(tar.extractfile(member))
                    continue
                entry = expected.get(member.name)
                if not entry:
                    raise BackupError("归档含额外成员")
                if (member.uid != entry["uid"] or member.gid != entry["gid"]
                        or format(member.mode & 0o7777, "04o") != entry["mode"]
                        or member.isdir() != (entry["type"] == "directory") or member.size != entry["bytes"]):
                    raise BackupError("归档成员权限/身份/大小不符")
                if member.isfile():
                    handle = tar.extractfile(member)
                    digest = hashlib.sha256()
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
                    if digest.hexdigest() != entry["sha256"]:
                        raise BackupError("归档成员哈希不符")
    except (tarfile.TarError, EOFError, OSError, ValueError) as error:
        raise BackupError("归档不可完整读取（疑似截断）") from error
    if seen != set(expected) | {"manifest.json"} or not isinstance(embedded, dict) or embedded.get("files") != files:
        raise BackupError("归档内 manifest 与实际内容不一致")


def unpack_isolated(partial: Path, target: Path) -> None:
    if target.exists():
        if any(target.iterdir()):
            raise BackupError("隔离恢复目标非空")
        raise BackupError("隔离恢复目标已存在，无法证明未被使用")
    target.mkdir(parents=True, exist_ok=False)
    directories = []
    seen = set()
    with tarfile.open(partial, "r:gz") as tar:
        for member in tar:
            safe_member(member)
            if member.name in seen:
                raise BackupError("恢复包含重复成员")
            seen.add(member.name)
            destination = target / member.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            attrs = {"uid": member.uid, "gid": member.gid, "mode": format(member.mode & 0o7777, "04o"), "mtime": member.mtime}
            if member.isdir():
                destination.mkdir(exist_ok=True)
                directories.append((destination, attrs))
            else:
                with destination.open("xb") as output:
                    shutil.copyfileobj(tar.extractfile(member), output)
                apply_metadata(destination, attrs)
    for directory, attrs in sorted(directories, key=lambda item: len(item[0].parts), reverse=True):
        apply_metadata(directory, attrs)


def verifier_report(image: str, roles: list[dict], restore: Path | None = None, snapshots: dict | None = None, *, require_idle: bool = False, require_locally_idle: bool = False, stopped_units: set[str] | None = None, allow_legacy: bool = False) -> dict:
    report = {"business": {}, "configs": {}}
    for role in roles:
        physical = (restore / role["archive"]) if restore else Path(role["source"])
        if role["role"] == "broker-config":
            report["configs"][role["archive"]] = {"sha256": sha256_file(physical), **metadata(physical)}
            continue
        if role["role"] == "codex-home":
            continue
        who = role["identity"]
        argv = ["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--user", f"{who['uid']}:{who['gid']}"]
        for group in who["groups"]:
            argv += ["--group-add", str(group)]
        selected = [role] + [other for other in roles if other["role"] == "codex-home" and other.get("unit") == role.get("unit")]
        for mounted in selected:
            source = (restore / mounted["archive"]) if restore else Path(mounted["source"])
            argv += ["-v", f"{source}:{mounted['logical']}:ro"]
        if not restore:
            for db, (snapshot, _) in (snapshots or {}).items():
                if db.is_relative_to(Path(role["source"])):
                    logical = Path(role["logical"]) / db.relative_to(Path(role["source"]))
                    argv += ["-v", f"{snapshot}:{logical}:ro"]
        argv += ["--entrypoint", "node", image, "/app/scripts/verify-production-backup.mjs",
                 "--role", role["role"], "--root", role["logical"]]
        if role.get("codexHome"):
            argv += ["--codex-home", role["codexHome"]]
        if require_idle:
            argv += ["--require-idle", "true"]
        if require_locally_idle:
            argv += ["--require-locally-idle", "true"]
        if allow_legacy and role["role"] == "broker-workspace":
            argv += ["--allow-legacy", "true"]
        if require_locally_idle and role.get("unit") in (stopped_units or set()):
            argv += ["--writer-stopped", "true"]
        result = run_command(argv, description="业务身份隔离读取")
        try:
            value = json.loads(require_command_success(result, "恢复验证容器"))
            if not isinstance(value, dict) or value.get("complete") is not True:
                raise ValueError()
            if require_idle and value.get("quiescent") is not True:
                raise ValueError()
            if require_locally_idle and value.get("localQuiescent") is not True:
                raise ValueError()
        except ValueError as error:
            raise BackupError("恢复验证报告不完整或不可解析") from error
        report["business"][role["archive"]] = value
    verify_request_links(report)
    return report


def verify_request_links(report: dict) -> None:
    stores = {}
    for business in report["business"].values():
        for store in business.get("stores", []):
            # 早期退休 store 没有 v3 身份；保留其字节和 legacy 摘要，但不能满足新请求关联。
            if store.get("storeId") is None and store.get("legacy") is True:
                continue
            if store["storeId"] in stores:
                raise BackupError("不同 broker 根出现重复 store-id，无法确认原请求归属")
            stores[store["storeId"]] = {item["requestId"]: item for item in store["records"]}
    for business in report["business"].values():
        for request in business.get("requests", []):
            actual = stores.get(request["binding"]["storeId"], {}).get(request["requestId"])
            if actual is None and request["required"]:
                raise BackupError("应用原请求缺少对应 broker durable record")
            if actual is not None and actual.get("binding") != request["binding"]:
                raise BackupError("应用与 broker 的原请求 binding 不一致")


def reports_match(source: dict, restored: dict) -> None:
    if source != restored:
        raise BackupError("恢复副本与源的业务报告不一致")


def fsync_path(target: Path) -> None:
    fd = os.open(target, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def retention_cleanup(backup_root: Path, retention_days: int, keep: Path) -> None:
    cutoff = time.time() - retention_days * 86400
    for candidate in backup_root.glob("video-factory-full-*.tar.gz"):
        if candidate == keep or candidate.stat().st_mtime >= cutoff:
            continue
        candidate.unlink()
        candidate.with_name(candidate.name[:-len(".tar.gz")] + ".json").unlink(missing_ok=True)
    for candidate in backup_root.glob("video-factory-metadata-*.tar.gz"):
        if candidate.stat().st_mtime < cutoff:
            candidate.unlink()


def publish_backup(partial: Path, staged_manifest: Path, archive: Path, sidecar: Path) -> None:
    # 成功标记最后发布；硬链接保证并发/重试绝不覆盖同名旧备份。
    linked_archive = False
    linked_sidecar = False
    try:
        os.link(partial, archive)
        linked_archive = True
        fsync_path(archive.parent)
        os.link(staged_manifest, sidecar)
        linked_sidecar = True
        fsync_path(sidecar.parent)
    except OSError:
        if linked_sidecar:
            sidecar.unlink()
        if linked_archive:
            archive.unlink()
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository-root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    os.umask(0o077)
    backup_root = Path(os.environ.get("VIDEO_FACTORY_BACKUP_DIR") or args.repository_root.parent / "backups/video-factory")
    maintenance_dir = Path(os.environ.get("VIDEO_FACTORY_MAINTENANCE_DIR") or DEFAULT_MAINTENANCE_DIR)
    owner = os.environ.get("VIDEO_FACTORY_MAINTENANCE_OWNER", "").strip()
    container = os.environ.get("VIDEO_FACTORY_CONTAINER", "video_factory_prod")
    workdir = None
    try:
        if not owner:
            raise BackupError("VIDEO_FACTORY_MAINTENANCE_OWNER 未提供")
        retention_days = int(os.environ.get("VIDEO_FACTORY_BACKUP_RETENTION", "7"))
        if retention_days < 1:
            raise BackupError("保留天数必须为正整数")
        backup_id = os.environ.get("VIDEO_FACTORY_BACKUP_ID", "").strip() or f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:8]}"
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", backup_id):
            raise BackupError("backup id 无效")
        archive = backup_root / f"video-factory-full-{backup_id}.tar.gz"
        sidecar = backup_root / f"video-factory-full-{backup_id}.json"
        if archive.exists():
            raise BackupError("备份目标已存在，拒绝覆盖")
        if sidecar.exists():
            raise BackupError("旧 sidecar 已存在，拒绝污染")
        with maintenance_lock(maintenance_dir):
            gate = assert_frozen_gate(maintenance_dir, owner, "precondition")
        roles, source, _ = resolve_sources(container)
        image = os.environ.get("VIDEO_FACTORY_BACKUP_VERIFY_IMAGE", "").strip() or source["image"]
        log("preconditions.ok", generation=gate["generation"], brokerUnits=source["writers"]["brokerUnits"])
        backup_root.mkdir(parents=True, exist_ok=True)
        for role in roles:
            if backup_root.resolve().is_relative_to(Path(role["source"]).resolve()):
                raise BackupError("备份目标不能位于持久源根内")
        workdir = Path(tempfile.mkdtemp(prefix=f".work-{backup_id}-", dir=backup_root))
        inventory = [(role, target) for role in roles for target in discover_files(Path(role["source"]), role["role"])]
        sqlite_paths = [target for _, target in inventory if target.is_file() and target.suffix in SQLITE_SUFFIXES]
        total = sum(target.stat().st_size for _, target in inventory if target.is_file())
        sqlite_bytes = sum(target.stat().st_size for target in sqlite_paths)
        available = shutil.disk_usage(backup_root).free
        needed = total * 2 + sqlite_bytes * 2 + len(inventory) * 4096
        if available < needed:
            raise BackupError(f"空间预检不足：需要约 {needed} 字节，可用 {available}")
        snapshots = {}
        for db in sqlite_paths:
            with db.open("rb") as handle:
                if handle.read(16) != SQLITE_MAGIC:
                    raise BackupError("SQLite 持久库头无效，拒绝跳过")
            snapshots[db] = snapshot_sqlite(db, workdir / "sqlite-stage")
        sidecars = {db.with_name(db.name + suffix) for db in snapshots for suffix in ("-wal", "-shm")}
        partial = workdir / "backup.tar.gz.partial"
        files = []
        sqlite_notes = []
        with tarfile.open(partial, "w:gz") as tar:
            for role, target in inventory:
                if target in sidecars:
                    continue
                relative = target.relative_to(role["source"])
                name = (Path(role["archive"]) / relative).as_posix()
                content = snapshots[target][0] if target in snapshots else target
                add_file(tar, content, name, files, metadata_source=target)
                if target in snapshots:
                    sqlite_notes.append({**snapshots[target][1], "logical": name})
            manifest = {"formatVersion": FORMAT_VERSION, "backupId": backup_id,
                        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "owner": owner, "gate": gate,
                        "source": source, "verification": {"image": image}, "roles": roles, "files": files,
                        "sqlite": sqlite_notes, "excluded": EXCLUSION_NOTES}
            manifest_bytes = json.dumps(manifest, ensure_ascii=False, indent=2).encode() + b"\n"
            member = tarfile.TarInfo("manifest.json")
            member.size, member.mode, member.uid, member.gid = len(manifest_bytes), 0o600, os.getuid(), os.getgid()
            tar.addfile(member, io.BytesIO(manifest_bytes))
        fsync_path(partial)
        verify_archive(partial, files)
        restore = workdir / "restore-verify"
        unpack_isolated(partial, restore)
        allow_legacy = os.environ.get("VIDEO_FACTORY_BACKUP_ALLOW_LEGACY") == "1"
        source_report = verifier_report(image, roles, snapshots=snapshots, allow_legacy=allow_legacy)
        restored_report = verifier_report(image, roles, restore=restore, allow_legacy=allow_legacy)
        reports_match(source_report, restored_report)
        log("restore.verified", roles=len(source_report["business"]))
        staged_manifest = workdir / "manifest.json.partial"
        with staged_manifest.open("xb") as handle:
            handle.write(manifest_bytes)
            handle.flush()
            os.fsync(handle.fileno())
        # 再次解析实际配置与退出状态；候选镜像/调用者 RELEASE_SHA 不参与源身份。
        final_roles, final_source, _ = resolve_sources(container)
        if final_roles != roles or final_source != source:
            raise BackupError("备份期间源配置或写者身份改变")
        with maintenance_lock(maintenance_dir):
            assert_frozen_gate(maintenance_dir, owner, "finalize", gate["generation"])
            publish_backup(partial, staged_manifest, archive, sidecar)
        retention_cleanup(backup_root, retention_days, archive)
        log("backup.published", archive=str(archive), manifest=str(sidecar))
        return 0
    except (BackupError, OSError, sqlite3.Error, ValueError) as error:
        detail = str(error) if isinstance(error, BackupError) else f"{type(error).__name__} ({getattr(error, 'errno', None)})"
        print(f"备份失败：{detail}", file=sys.stderr)
        return 1
    finally:
        if workdir is not None:
            shutil.rmtree(workdir)


if __name__ == "__main__":
    sys.exit(main())
