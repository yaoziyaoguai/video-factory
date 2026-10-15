import argparse
import copy
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = REPOSITORY_ROOT / "scripts" / "production-cold-upgrade.py"
spec = importlib.util.spec_from_file_location("production_cold_upgrade_under_test", HELPER_PATH)
cold = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cold)
backup = cold.backup
DEEPSEEK = "vf-deepseek-codex-broker.service"
OPENAI = "vf-codex-broker.service"
ZAI = "vf-zai-codex-broker.service"
PREVIOUS = "a" * 40
CANDIDATE = "b" * 40
ORIGINAL_IMAGE = "sha256:" + "c" * 64
CANDIDATE_IMAGE = "sha256:" + "d" * 64
MODEL_ID = "m-0123456789ab"


class ProductionColdUpgradeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="vf-cold-upgrade-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.app_root = self.root / "app-workspace"
        self.app_root.mkdir()
        self.release = self.root / "broker" / "releases" / PREVIOUS
        (self.release / "dist").mkdir(parents=True)
        (self.release / "dist" / "main.js").write_text("original main\n")
        (self.release / "dist" / "broker-server.js").write_text("original server\n")
        self.current = self.release.parent.parent / "current"
        self.current.symlink_to(self.release, target_is_directory=True)
        self.last_release = self.root / "last-release"
        self.last_release.write_text(PREVIOUS + "\n")
        self.state_path = self.root / "transaction.json"
        self.ingress_path = self.root / "ingress.json"
        self.args = argparse.Namespace(
            state=self.state_path, previous_release=PREVIOUS, candidate_release=CANDIDATE,
            container="test_original_app", image="test_candidate_image",
            last_release=self.last_release, broker_current=self.current,
            ingress=self.ingress_path, node="/test/node",
            maintenance_directory=self.root / "maintenance",
        )
        self.container = {
            "Id": "e" * 64, "Image": ORIGINAL_IMAGE,
            "State": {"Running": True, "Pid": 123, "Restarting": False, "Dead": False, "Status": "running"},
            "Config": {"User": "1001:1001", "Env": ["VIDEO_FACTORY_RELEASE_SHA=" + PREVIOUS]},
            "HostConfig": {"GroupAdd": []},
            "Mounts": [{"Destination": "/data/factory", "Source": str(self.app_root)}],
            "NetworkSettings": {"Ports": {"4317/tcp": [{"HostIp": "127.0.0.1", "HostPort": "4317"}]}},
        }
        self.identity = {"uid": 1001, "gid": 1001, "groups": [1001]}
        self.units = {}
        self.socket_paths = set()
        self.health_responses = {}
        self.add_unit(DEEPSEEK, "deepseek", active=True)
        self.add_unit(OPENAI, "openai", active=False)
        self.units[ZAI] = {
            "Id": ZAI, "LoadState": "not-found", "ActiveState": "inactive", "SubState": "dead",
            "MainPID": "0", "ControlPID": "0", "ControlGroup": "",
        }
        self.commands = []
        self.stop_readback = "TimeoutStopUSec=infinity\nSendSIGKILL=no\n"
        self.ingress_exit = 0
        self.verifier_value = {"complete": True, "quiescent": True, "localQuiescent": True, "stores": [], "requests": []}
        self.command_mock = self.enter_patch(backup, "run_command", side_effect=self.run_command)
        self.enter_patch(backup, "system_identity", side_effect=lambda status: copy.deepcopy(self.identity))
        self.health_mock = self.enter_patch(cold, "health", side_effect=self.health)
        # 外部命令、HTTP 和 socket 类型检查是显式替身；其余解析、身份比较和落盘运行正式代码。
        self.enter_patch(Path, "is_socket", autospec=True, side_effect=lambda path: str(path) in self.socket_paths)
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def enter_patch(self, target, name, **kwargs):
        patcher = patch.object(target, name, **kwargs)
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def add_unit(self, unit, profile, *, active):
        workspace = self.root / (unit + "-workspace")
        workspace.mkdir(exist_ok=True)
        socket_dir = self.root / (unit + "-sockets")
        socket_dir.mkdir(exist_ok=True)
        main_socket = socket_dir / "worker.sock"
        env_file = self.root / (unit + ".env")
        env_file.write_text(
            f"VIDEO_FACTORY_CODEX_WORKSPACE_ROOT={workspace}\n"
            f"VIDEO_FACTORY_CODEX_PROFILE={profile}\n"
            f"VIDEO_FACTORY_CODEX_SOCKET_PATH={main_socket}\n"
        )
        self.units[unit] = {
            "Id": unit, "LoadState": "loaded", "ActiveState": "active" if active else "inactive",
            "SubState": "running" if active else "dead", "MainPID": "321" if active else "0",
            "ControlPID": "0", "ControlGroup": "", "User": "1001", "Group": "1001",
            "SupplementaryGroups": "", "DynamicUser": "no", "Environment": "",
            "EnvironmentFiles": f"{env_file} (ignore_errors=no)",
        }
        if active:
            for target in (main_socket, socket_dir / (MODEL_ID + ".sock")):
                target.touch()
                self.socket_paths.add(str(target))
                self.health_responses[(str(target), "/health")] = {
                    "protocolVersion": "video-factory/codex-bridge-v2", "active": 0, "queued": 0,
                    "profileId": profile, "providerId": profile, "modelId": "fixture-model",
                    "storeId": unit + target.name, "startedAt": "2026-10-15T00:00:00Z",
                }
            self.health_responses[(str(main_socket), "/v1/models")] = {
                "models": [{"id": MODEL_ID, "socketName": MODEL_ID + ".sock"}],
            }
        return main_socket

    def health(self, filename, resource="/health"):
        key = (filename, resource)
        if key not in self.health_responses:
            raise AssertionError(f"Unexpected health request: {key}")
        return copy.deepcopy(self.health_responses[key])

    def run_command(self, argv, *, description):
        argv = list(argv)
        self.commands.append(argv)
        output = ""
        code = 0
        if argv[:2] == ["docker", "inspect"]:
            if argv[2] == self.args.container:
                output = json.dumps([self.container])
            elif argv[2] == self.args.image:
                output = json.dumps([{"Id": CANDIDATE_IMAGE}])
            else:
                raise AssertionError(f"Unexpected docker inspect: {argv}")
        elif argv[:2] == ["docker", "run"] and "--eval" in argv:
            output = json.dumps(self.identity)
        elif argv[:2] == ["docker", "run"] and "/app/scripts/verify-production-backup.mjs" in argv:
            output = json.dumps(self.verifier_value)
        elif argv[:2] in (["systemctl", "list-unit-files"], ["systemctl", "list-units"]):
            output = "\n".join(unit + " loaded" for unit, value in self.units.items() if value["LoadState"] == "loaded")
        elif argv[:2] == ["systemctl", "show"]:
            if "--property=TimeoutStopUSec,SendSIGKILL" in argv:
                output = self.stop_readback[argv[2]] if isinstance(self.stop_readback, dict) else self.stop_readback
            else:
                output = "\n".join(f"{key}={value}" for key, value in self.units[argv[2]].items())
        elif argv == ["systemctl", "daemon-reload"]:
            pass
        elif argv[:2] == ["systemctl", "stop"] and len(argv) == 3:
            self.units[argv[2]].update(ActiveState="inactive", SubState="dead", MainPID="0", ControlPID="0")
        elif argv == [self.args.node, str(HELPER_PATH.with_name("production-cold-ingress.mjs")), "status", str(self.ingress_path)]:
            output = json.dumps({"phase": "closed", "drained": True})
            code = self.ingress_exit
        else:
            raise AssertionError(f"Unexpected external command: {argv} ({description})")
        return subprocess.CompletedProcess(argv, code, stdout=output, stderr="")

    def prepared(self):
        cold.prepare(self.args)
        return cold.private_json(self.state_path)

    def close_ingress(self):
        cold.write_new(self.ingress_path, {"phase": "closed"})

    def stop_app(self):
        self.container["State"].update(Running=False, Pid=0, Status="exited")

    def stop_units(self):
        for status in self.units.values():
            status.update(ActiveState="inactive", SubState="dead", MainPID="0", ControlPID="0")

    def invoke(self, command):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", [str(HELPER_PATH), command, str(self.state_path)]), \
                patch.object(cold.os, "umask"), redirect_stdout(stdout), redirect_stderr(stderr):
            result = cold.main()
        return result, stdout.getvalue(), stderr.getvalue()

    @contextmanager
    def runtime_directory(self, name):
        runtime = self.root / name
        runtime.mkdir()

        def local_path(value):
            target = Path(value)
            systemd_root = Path("/run/systemd/system")
            if target.is_relative_to(systemd_root):
                return runtime / target.relative_to(systemd_root)
            return target

        # 固定的宿主 runtime 路径只重定向到本测试的新目录，绝不触碰真正的 /run。
        with patch.object(cold, "Path", side_effect=local_path):
            yield runtime

    def test_prepare_records_actual_artifacts_and_every_discovered_unit(self):
        archived = "vf-archived-broker.service"
        custom = "custom-broker.service"
        unrelated = "token-talk-codex-broker.service"
        self.add_unit(archived, "zai", active=False)
        self.add_unit(custom, "openai", active=False)
        self.units[custom]["Environment"] = f"VIDEO_FACTORY_CODEX_WORKSPACE_ROOT={self.root / (custom + '-workspace')}"
        self.units[unrelated] = {
            **self.units[DEEPSEEK], "Id": unrelated, "Environment": "", "EnvironmentFiles": "",
            "ExecStart": "/opt/token-talk/broker/main.js",
        }
        valid_report = copy.deepcopy(self.verifier_value)
        for invalid in ({"complete": False, "localQuiescent": True}, {"complete": True}, {"complete": True, "localQuiescent": False}):
            with self.subTest(preflight_report=invalid):
                self.verifier_value = invalid
                self.commands.clear()
                with self.assertRaisesRegex(cold.Error, "报告不完整"):
                    cold.prepare(self.args)
                self.assertFalse(self.state_path.exists())
                self.assertFalse(self.ingress_path.exists())
                self.assertFalse(any(argv[:2] == ["systemctl", "stop"] or argv[0] == self.args.node for argv in self.commands))
        self.verifier_value = valid_report

        def before_state_command(argv, *, description):
            if "/app/scripts/verify-production-backup.mjs" in argv:
                self.assertFalse(self.state_path.exists())
            return self.run_command(argv, description=description)

        with patch.object(backup, "run_command", side_effect=before_state_command):
            state = self.prepared()
        self.assertEqual(state["statePath"], str(self.state_path))
        self.assertEqual(state["previousRelease"], PREVIOUS)
        self.assertEqual(state["candidateRelease"], CANDIDATE)
        self.assertEqual(state["container"], {"id": self.container["Id"], "image": ORIGINAL_IMAGE})
        self.assertEqual(state["candidateImage"], CANDIDATE_IMAGE)
        self.assertEqual(state["brokerRelease"], str(self.release))
        self.assertEqual(set(state["units"]), set(self.units) - {unrelated})
        self.assertTrue(state["units"][DEEPSEEK]["active"])
        for unit in (OPENAI, ZAI, archived, custom):
            self.assertFalse(state["units"][unit]["active"])
        self.assertEqual({role["unit"] for role in state["roles"] if role["role"] == "broker-workspace"}, {DEEPSEEK, OPENAI, archived, custom})
        model_socket = str(Path(state["units"][DEEPSEEK]["socket"]).parent / (MODEL_ID + ".sock"))
        self.health_mock.assert_any_call(model_socket)
        self.assertEqual(stat.S_IMODE(self.state_path.stat().st_mode), 0o600)

    def test_prepare_identifies_verifier_failure_without_exposing_output(self):
        controlled = "持久执行租约或未完成写入仍存在"
        cases = (
            (f"verify-production-backup: 业务完整性验证失败 ({controlled})\n", "reason-sha256=" + cold.hashlib.sha256(controlled.encode()).hexdigest()),
            ("verify-production-backup: 业务完整性验证失败 (EACCES)\n", "reason-sha256=" + cold.hashlib.sha256(b"EACCES").hexdigest()),
            ("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/private/FAKE-KEY'\n", "code=ERR_MODULE_NOT_FOUND"),
            ("FAKE-KEY: unstructured provider payload\n", "diagnostic=unclassified"),
        )
        for stderr, expected in cases:
            with self.subTest(stderr=stderr):
                def fail_verifier(argv, *, description):
                    if "/app/scripts/verify-production-backup.mjs" in argv:
                        return subprocess.CompletedProcess(argv, 1, stdout="FAKE-KEY private stdout", stderr=stderr)
                    return self.run_command(argv, description=description)

                with patch.object(backup, "run_command", side_effect=fail_verifier):
                    with self.assertRaises(cold.Error) as raised:
                        cold.prepare(self.args)
                message = str(raised.exception)
                self.assertIn("role=app-workspace", message)
                self.assertIn("index=0", message)
                self.assertIn("exit=1", message)
                self.assertIn(expected, message)
                self.assertNotIn("FAKE-KEY", message)
                self.assertNotIn(controlled, message)
                self.assertNotIn(str(self.root), message)
                self.assertFalse(self.state_path.exists())
                self.assertFalse(self.ingress_path.exists())
                self.assertFalse(any(argv[:2] == ["systemctl", "stop"] for argv in self.commands))

    def test_verifier_failure_identifies_the_failing_broker_role_index(self):
        roles = [{"role": role, "source": str(self.app_root), "logical": "/data/test",
                  "archive": "private-FAKE-KEY", "identity": self.identity}
                 for role in ("app-workspace", "broker-workspace")]
        success = subprocess.CompletedProcess([], 0, stdout=json.dumps(self.verifier_value), stderr="")
        failure = subprocess.CompletedProcess([], 125, stdout="", stderr="private-FAKE-KEY")
        with patch.object(backup, "run_command", side_effect=[success, failure]):
            with self.assertRaises(backup.BackupError) as raised:
                backup.verifier_report(CANDIDATE_IMAGE, roles)
        self.assertIn("role=broker-workspace, index=1, exit=125", str(raised.exception))
        self.assertNotIn("FAKE-KEY", str(raised.exception))

    def test_prepare_requires_exact_distinct_shas_and_matching_previous_release(self):
        cases = (
            ("short previous SHA", {"previous_release": PREVIOUS[:7]}, PREVIOUS, PREVIOUS, "准确原版本和候选 SHA"),
            ("short candidate SHA", {"candidate_release": CANDIDATE[:7]}, PREVIOUS, PREVIOUS, "准确原版本和候选 SHA"),
            ("same release", {"candidate_release": PREVIOUS}, PREVIOUS, PREVIOUS, "准确原版本和候选 SHA"),
            ("wrong last release", {}, CANDIDATE, PREVIOUS, "最后成功发布不符"),
            ("wrong app echo", {}, PREVIOUS, CANDIDATE, "版本回显"),
        )
        for name, changes, last_release, echoed_release, error in cases:
            with self.subTest(name=name):
                args = copy.copy(self.args)
                vars(args).update(changes)
                self.last_release.write_text(last_release + "\n")
                self.container["Config"]["Env"] = ["VIDEO_FACTORY_RELEASE_SHA=" + echoed_release]
                with self.assertRaisesRegex(cold.Error, error):
                    cold.prepare(args)
                self.assertFalse(self.state_path.exists())

    def test_prepare_requires_running_container_identity_and_only_loopback_ports(self):
        baseline = copy.deepcopy(self.container)
        cases = (
            ("stopped", lambda info: info["State"].update(Running=False), "正在运行"),
            ("image tag", lambda info: info.update(Image="video-factory:latest"), "身份明确"),
            ("short container ID", lambda info: info.update(Id="e" * 12), "身份明确"),
            ("wildcard ipv4", lambda info: info["NetworkSettings"]["Ports"]["4317/tcp"][0].update(HostIp="0.0.0.0"), "loopback"),
            ("wildcard ipv6", lambda info: info["NetworkSettings"]["Ports"]["4317/tcp"][0].update(HostIp="::"), "loopback"),
            ("wrong port", lambda info: info["NetworkSettings"]["Ports"]["4317/tcp"][0].update(HostPort="8080"), "loopback"),
            ("no binding", lambda info: info["NetworkSettings"]["Ports"].update({"4317/tcp": []}), "loopback"),
            ("extra port", lambda info: info["NetworkSettings"]["Ports"].update({"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]}), "未覆盖的外部端口"),
        )
        for name, mutate, error in cases:
            with self.subTest(name=name):
                self.container = copy.deepcopy(baseline)
                mutate(self.container)
                with self.assertRaisesRegex(cold.Error, error):
                    cold.prepare(self.args)
                self.assertFalse(self.state_path.exists())
        self.container = copy.deepcopy(baseline)
        self.container["NetworkSettings"]["Ports"]["4317/tcp"].append({"HostIp": "::1", "HostPort": "4317"})
        self.prepared()

    def test_prepare_refuses_unsafe_broker_states_and_uncovered_model_sockets(self):
        baseline_units = copy.deepcopy(self.units)
        baseline_health = copy.deepcopy(self.health_responses)
        socket_path = Path(cold.selected_socket(self.units[DEEPSEEK]))
        models_key = (str(socket_path), "/v1/models")
        cases = (
            ("missing PID", lambda: self.units[DEEPSEEK].update(MainPID="0"), "不能恢复的活动 broker"),
            ("control process", lambda: self.units[DEEPSEEK].update(ControlPID="987"), "不能恢复的活动 broker"),
            ("inactive process", lambda: self.units[OPENAI].update(MainPID="987"), "退出状态无法证明"),
            ("no DeepSeek", lambda: self.units[DEEPSEEK].update(ActiveState="inactive", SubState="dead", MainPID="0"), "DeepSeek 服务正在运行"),
            ("missing model list", lambda: self.health_responses[models_key].clear(), "模型清单不完整"),
            ("duplicate model", lambda: self.health_responses[models_key]["models"].append({"id": MODEL_ID, "socketName": MODEL_ID + ".sock"}), "socket 身份冲突"),
            ("model path escape", lambda: self.health_responses[models_key]["models"][0].update(socketName="../other.sock"), "socket 身份冲突"),
            ("unannounced model", lambda: self.health_responses[models_key].update(models=[]), "未覆盖的 socket"),
        )
        for name, mutate, error in cases:
            with self.subTest(name=name):
                self.units = copy.deepcopy(baseline_units)
                self.health_responses = copy.deepcopy(baseline_health)
                mutate()
                with self.assertRaisesRegex(cold.Error, error):
                    cold.prepare(self.args)
                self.assertFalse(self.state_path.exists())
        self.units = copy.deepcopy(baseline_units)
        self.health_responses = copy.deepcopy(baseline_health)
        self.add_unit("vf-unmanaged-broker.service", "zai", active=True)
        with self.assertRaisesRegex(cold.Error, "不能恢复的活动 broker"):
            cold.prepare(self.args)
        self.assertFalse(self.state_path.exists())

    def test_prepare_refuses_active_queued_or_unverifiable_default_and_model_tasks(self):
        baseline = copy.deepcopy(self.health_responses)
        main_socket = Path(cold.selected_socket(self.units[DEEPSEEK]))
        for endpoint in (main_socket, main_socket.parent / (MODEL_ID + ".sock")):
            for field, value in (("active", 1), ("queued", 1), ("active", None), ("queued", None), ("protocolVersion", "unknown")):
                with self.subTest(socket=endpoint.name, field=field, value=value):
                    self.health_responses = copy.deepcopy(baseline)
                    response = self.health_responses[(str(endpoint), "/health")]
                    if value is None:
                        del response[field]
                    else:
                        response[field] = value
                    with self.assertRaisesRegex(cold.Error, "执行/排队任务|状态不可核实"):
                        cold.prepare(self.args)
                    self.assertFalse(self.state_path.exists())
        self.health_responses = copy.deepcopy(baseline)
        self.health_responses[(str(main_socket), "/health")]["profileId"] = "openai"
        with self.assertRaisesRegex(cold.Error, "身份与实际配置不符"):
            cold.prepare(self.args)

    def test_live_brokers_refuses_missing_inactive_new_or_restarted_units(self):
        state = self.prepared()
        baseline = copy.deepcopy(self.units)
        cases = (
            ("inactive disappears", lambda units: units.pop(OPENAI), "服务清单改变"),
            ("new inactive unit", lambda units: units.update({"vf-new-broker.service": copy.deepcopy(units[OPENAI])}), "服务清单改变"),
            ("inactive wakes", lambda units: units[OPENAI].update(ActiveState="active", SubState="running", MainPID="789"), "原先退出的 broker 状态改变"),
            ("PID replaced", lambda units: units[DEEPSEEK].update(MainPID="789"), "重启或退出"),
        )
        for name, mutate, error in cases:
            with self.subTest(name=name):
                units = copy.deepcopy(baseline)
                mutate(units)
                with self.assertRaisesRegex(cold.Error, error):
                    cold.live_brokers(state, units)

    def test_original_identity_refuses_changed_container_release_or_broker_artifact(self):
        state = self.prepared()
        cold.original_identity(state)
        original = copy.deepcopy(self.container)
        for field, changed in (("Id", "f" * 64), ("Image", CANDIDATE_IMAGE)):
            with self.subTest(field=field):
                self.container = copy.deepcopy(original)
                self.container[field] = changed
                with self.assertRaisesRegex(cold.Error, "app 制品身份改变"):
                    cold.original_identity(state)
        self.container = original
        self.last_release.write_text(CANDIDATE + "\n")
        with self.assertRaisesRegex(cold.Error, "最后成功版本"):
            cold.original_identity(state)
        self.last_release.write_text(PREVIOUS + "\n")
        main = self.release / "dist" / "main.js"
        main.write_text("changed original\n")
        with self.assertRaisesRegex(cold.Error, "broker 制品身份改变"):
            cold.original_identity(state)
        main.write_text("original main\n")
        other_release = self.release.parent / CANDIDATE
        (other_release / "dist").mkdir(parents=True)
        for source in (self.release / "dist").iterdir():
            (other_release / "dist" / source.name).write_bytes(source.read_bytes())
        self.current.unlink()
        self.current.symlink_to(other_release, target_is_directory=True)
        with self.assertRaisesRegex(cold.Error, "broker 制品身份改变"):
            cold.original_identity(state)

    def test_stable_roles_refuses_changed_persistent_roots_and_business_identity(self):
        state = self.prepared()
        cold.stable_roles(state)
        other_root = self.root / "replacement-workspace"
        other_root.mkdir()
        self.container["Mounts"][0]["Source"] = str(other_root)
        with self.assertRaisesRegex(cold.Error, "持久根或执行身份"):
            cold.stable_roles(state)
        self.container["Mounts"][0]["Source"] = str(self.app_root)
        env_file = self.root / (OPENAI + ".env")
        contents = env_file.read_text()
        env_file.write_text(contents.replace(str(self.root / (OPENAI + "-workspace")), str(other_root)))
        with self.assertRaisesRegex(cold.Error, "持久根或执行身份"):
            cold.stable_roles(state)
        env_file.write_text(contents)
        self.identity = {"uid": 1002, "gid": 1001, "groups": [1001]}
        with self.assertRaisesRegex(cold.Error, "持久根或执行身份"):
            cold.stable_roles(state)

    def test_ingress_requires_closed_marker_and_successful_controller_drain_recheck(self):
        state = self.prepared()
        self.close_ingress()
        self.commands.clear()
        cold.ingress_closed(state)
        expected = [self.args.node, str(HELPER_PATH.with_name("production-cold-ingress.mjs")), "status", str(self.ingress_path)]
        self.assertEqual(self.commands, [expected])
        self.ingress_exit = 1
        with self.assertRaisesRegex(cold.Error, "入口屏障复核.*失败"):
            cold.ingress_closed(state)
        self.ingress_exit = 0
        self.ingress_path.write_text(json.dumps({"phase": "closing"}))
        self.commands.clear()
        with self.assertRaisesRegex(cold.Error, "尚未关闭并排空"):
            cold.ingress_closed(state)
        self.assertEqual(self.commands, [])

    @contextmanager
    def app_stop_fixture(self, *, legacy=True, normal_exit=False, exit_code=0, terminate_on_signal=True):
        state = self.prepared()
        self.close_ingress()
        (self.app_root / "runs").mkdir()
        if legacy:
            state["previousRelease"] = cold.LEGACY_RELEASE
            state["container"]["image"] = cold.LEGACY_IMAGE
            self.last_release.write_text(cold.LEGACY_RELEASE + "\n")
            self.container["Image"] = cold.LEGACY_IMAGE
        self.container["RestartCount"] = 0
        self.container["State"].update(StartedAt="2026-10-15T00:00:00Z", OOMKilled=False, ExitCode=0)
        proof = {"pid": 123, "startTime": "1234", "bootId": "01234567-89ab-cdef-0123-456789abcdef", "cgroup": "0::/fixture\n"}
        observed = {"clock": 0.0, "events": [], "helper": None}
        controller = Mock()
        controller.returncode = None
        controller.poll.side_effect = lambda: controller.returncode
        def wait_controller(timeout):
            if self.container["State"]["Running"]:
                self.raise_timeout(timeout)
            controller.returncode = 0
            return 0
        controller.wait.side_effect = wait_controller
        controller.terminate.side_effect = lambda: observed["events"].append("controller-terminate")

        def stop():
            self.stop_app()
            self.container["State"]["ExitCode"] = exit_code

        def popen(argv, **kwargs):
            observed["events"].append("docker-stop")
            self.assertEqual(argv, ["docker", "stop", "--time", "-1", self.container["Id"]])
            if normal_exit:
                stop()
            return controller

        def sigterm(descriptor, sig):
            self.assertEqual(descriptor, 90)
            self.assertEqual(sig, cold.signal.SIGTERM)
            observed["events"].append("sigterm")
            if terminate_on_signal:
                stop()

        def command(argv, **kwargs):
            if argv[:2] == ["docker", "inspect"]:
                self.assertEqual(argv[2], self.container["Id"])
                self.assertEqual(kwargs["timeout"], 3)
                return subprocess.CompletedProcess(argv, 0, stdout=json.dumps([self.container]), stderr="")
            if argv[:3] == ["docker", "exec", "-i"]:
                self.assertEqual(argv[3:7], [self.container["Id"], "node", "--input-type=module", "-"])
                self.assertEqual(json.loads(argv[7]), {key: proof[key] for key in ("startTime", "bootId")})
                self.assertEqual(kwargs["timeout"], 20)
                self.assertIn("process.once('SIGTERM', onTerm)", kwargs["input"])
                observed["events"].append("arm")
                if observed["helper"] is not None:
                    return observed["helper"](argv, kwargs)
                return subprocess.CompletedProcess(argv, 0, stdout=json.dumps({"mode": "legacy-once", "debuggerClosed": True, **proof}), stderr="")
            raise AssertionError(argv)

        def tick(seconds):
            observed["clock"] += seconds

        with patch.object(cold, "app_process", return_value=proof), \
                patch.object(cold.os, "pidfd_open", return_value=90, create=True) as opened, \
                patch.object(cold.os, "close") as closed, \
                patch.object(cold.signal, "pidfd_send_signal", side_effect=sigterm, create=True), \
                patch.object(cold.time, "monotonic", side_effect=lambda: observed["clock"]), \
                patch.object(cold.time, "sleep", side_effect=tick), \
                patch.object(cold.subprocess, "run", side_effect=command), \
                patch.object(cold.subprocess, "Popen", side_effect=popen):
            yield state, observed, controller, opened, closed

    @staticmethod
    def raise_timeout(timeout):
        raise subprocess.TimeoutExpired("docker stop", timeout)

    def test_stop_app_uses_manual_stop_then_exact_signal_only_after_legacy_debugger_is_closed(self):
        with self.app_stop_fixture() as (state, observed, controller, opened, closed):
            self.assertEqual(cold.stop_app(state), "legacy-once")
            self.assertEqual(observed["events"], ["docker-stop", "arm", "sigterm"])
            opened.assert_called_once_with(123)
            closed.assert_called_once_with(90)
            controller.terminate.assert_not_called()
            self.assertFalse(self.container["State"]["Running"])

    def test_stop_app_with_existing_native_handler_never_enables_debugger(self):
        with self.app_stop_fixture(normal_exit=True) as (state, observed, *_):
            self.assertEqual(cold.stop_app(state), "normal")
            self.assertEqual(observed["events"], ["docker-stop"])

    def test_stop_app_nonlegacy_image_can_only_use_normal_signal_and_times_out_without_force(self):
        with self.app_stop_fixture(legacy=False, terminate_on_signal=False) as (state, observed, controller, _, closed):
            with self.assertRaisesRegex(cold.Error, "正常停止超时"):
                cold.stop_app(state)
            self.assertEqual(observed["events"], ["docker-stop", "sigterm", "controller-terminate"])
            self.assertLessEqual(observed["clock"], cold.APP_STOP_TIMEOUT + 0.2)
            self.assertTrue(self.container["State"]["Running"])
            controller.terminate.assert_called_once()
            closed.assert_called_once_with(90)

    def test_stop_app_refuses_nonempty_runs_without_arming_or_sending_extra_signal(self):
        with self.app_stop_fixture() as (state, observed, *_):
            (self.app_root / "runs" / "even-completed-run.json").write_text("{}")
            with self.assertRaisesRegex(cold.Error, "空 runs"):
                cold.stop_app(state)
            self.assertEqual(observed["events"], ["docker-stop", "controller-terminate"])
            self.assertTrue(self.container["State"]["Running"])

    def test_stop_app_refuses_debug_cleanup_failure_and_preserves_live_app(self):
        with self.app_stop_fixture() as (state, observed, *_):
            observed["helper"] = lambda argv, kwargs: subprocess.CompletedProcess(argv, 0, stdout='{"mode":"legacy-once","debuggerClosed":false}', stderr="")
            with self.assertRaisesRegex(cold.Error, "调试口清理未得到证明"):
                cold.stop_app(state)
            self.assertEqual(observed["events"], ["docker-stop", "arm", "controller-terminate"])
            self.assertTrue(self.container["State"]["Running"])

    def test_stop_app_requires_exit_zero(self):
        with self.app_stop_fixture(normal_exit=True, exit_code=143) as (state, *_):
            with self.assertRaisesRegex(cold.Error, "exit 0"):
                cold.stop_app(state)

    def test_stop_identity_binds_container_start_time_restart_count_and_pid(self):
        expected = copy.deepcopy(self.container)
        expected["RestartCount"] = 0
        expected["State"]["StartedAt"] = "original"
        for changed in ("id", "image", "start", "restart", "pid"):
            with self.subTest(changed=changed):
                info = copy.deepcopy(expected)
                if changed == "id":
                    info["Id"] = "f" * 64
                elif changed == "image":
                    info["Image"] = CANDIDATE_IMAGE
                elif changed == "start":
                    info["State"]["StartedAt"] = "new"
                elif changed == "restart":
                    info["RestartCount"] = 1
                result = subprocess.CompletedProcess([], 0, stdout=json.dumps([info]))
                with patch.object(cold.subprocess, "run", return_value=result), patch.object(cold, "app_process", return_value={"pid": 456}):
                    with self.assertRaisesRegex(cold.Error, "身份改变|重启|PID.*改变"):
                        cold.stop_identity({"container": {"id": expected["Id"]}}, expected, {"pid": 123})

    def test_legacy_stop_rejects_unknown_image_and_unverified_node_options(self):
        with self.app_stop_fixture() as (state, observed, *_):
            expected = copy.deepcopy(self.container)
            proof = {"pid": 123, "startTime": "1234", "bootId": "01234567-89ab-cdef-0123-456789abcdef", "cgroup": "0::/fixture\n"}
            expected["Image"] = ORIGINAL_IMAGE
            with self.assertRaisesRegex(cold.Error, "兼容镜像"):
                cold.arm_legacy_stop(state, expected, proof)
            expected = copy.deepcopy(self.container)
            expected["Config"]["Env"].append("NODE_OPTIONS=--inspect-port=0.0.0.0:9333")
            with self.assertRaisesRegex(cold.Error, "未核实.*参数"):
                cold.arm_legacy_stop(state, expected, proof)
            self.assertEqual(observed["events"], [])

    def test_stop_app_rejects_debug_helper_timeout_without_signalling(self):
        with self.app_stop_fixture() as (state, observed, *_):
            def timeout(argv, kwargs):
                raise subprocess.TimeoutExpired(argv, kwargs["timeout"])
            observed["helper"] = timeout
            with self.assertRaisesRegex(cold.Error, "调试口清理未证明"):
                cold.stop_app(state)
            self.assertEqual(observed["events"], ["docker-stop", "arm", "controller-terminate"])
            self.assertTrue(self.container["State"]["Running"])

    def test_stop_app_rejects_docker_stop_signal_override_before_mutation(self):
        with self.app_stop_fixture() as (state, observed, *_):
            self.container["Config"]["StopSignal"] = "SIGKILL"
            with self.assertRaisesRegex(cold.Error, "不是正常 SIGTERM"):
                cold.stop_app(state)
            self.assertEqual(observed["events"], [])

    def test_stop_app_requires_fresh_ingress_and_idle_before_starting_stop(self):
        with self.app_stop_fixture() as (state, observed, *_):
            self.ingress_exit = 1
            with self.assertRaisesRegex(cold.Error, "入口屏障复核"):
                cold.stop_app(state)
            self.assertEqual(observed["events"], [])
            self.ingress_exit = 0
            self.health_responses[(state["units"][DEEPSEEK]["socket"], "/health")]["active"] = 1
            with self.assertRaisesRegex(cold.Error, "执行/排队任务"):
                cold.stop_app(state)
            self.assertEqual(observed["events"], [])

    def test_normal_stop_installs_and_verifies_own_protections_before_any_stop(self):
        self.add_unit(OPENAI, "openai", active=True)
        state = self.prepared()
        self.close_ingress()
        self.stop_app()
        original_units = copy.deepcopy(self.units)
        original_health = copy.deepcopy(self.health_responses)
        cases = (
            ("success", "TimeoutStopUSec=infinity\nSendSIGKILL=no\n", True),
            ("finite timeout", "TimeoutStopUSec=5s\nSendSIGKILL=no\n", False),
            ("forced kill enabled", "TimeoutStopUSec=infinity\nSendSIGKILL=yes\n", False),
            ("missing readback", "", False),
            ("second unit unprotected", {
                DEEPSEEK: "TimeoutStopUSec=infinity\nSendSIGKILL=yes\n",
                OPENAI: "TimeoutStopUSec=infinity\nSendSIGKILL=no\n",
            }, False),
            ("work appeared before stop", "TimeoutStopUSec=infinity\nSendSIGKILL=no\n", False),
        )
        for name, readback, succeeds in cases:
            with self.subTest(name=name), self.runtime_directory(name.replace(" ", "-")) as runtime:
                self.units = copy.deepcopy(original_units)
                self.health_responses = copy.deepcopy(original_health)
                self.stop_readback = readback
                self.commands.clear()
                state_path = self.root / (name.replace(" ", "-") + ".json")

                def guarded_command(argv, *, description):
                    if "--property=TimeoutStopUSec,SendSIGKILL" in argv or argv[:2] == ["systemctl", "stop"]:
                        for unit in (DEEPSEEK, OPENAI):
                            drop_in = runtime / (unit + ".d") / "99-video-factory-cold-stop.conf"
                            self.assertEqual(drop_in.read_text(), "[Service]\nTimeoutStopSec=infinity\nSendSIGKILL=no\n")
                    if name == "work appeared before stop" and "--property=TimeoutStopUSec,SendSIGKILL" in argv:
                        self.health_responses[(state["units"][DEEPSEEK]["socket"], "/health")]["queued"] = 1
                    return self.run_command(argv, description=description)

                with patch.object(backup, "run_command", side_effect=guarded_command):
                    if succeeds:
                        cold.protect_stops(state, state_path)
                    else:
                        error = "执行/排队任务" if name == "work appeared before stop" else "不超时强杀"
                        with self.assertRaisesRegex(cold.Error, error):
                            cold.protect_stops(state, state_path)
                protection_file = state_path.with_suffix(".stop-protection.json")
                protection = cold.private_json(protection_file)
                self.assertEqual({item["unit"] for item in protection["protections"]}, {DEEPSEEK, OPENAI})
                for item in protection["protections"]:
                    target = runtime / (item["unit"] + ".d") / "99-video-factory-cold-stop.conf"
                    self.assertEqual(Path(item["path"]), target)
                    self.assertEqual(target.read_text(), "[Service]\nTimeoutStopSec=infinity\nSendSIGKILL=no\n")
                stops = [argv for argv in self.commands if argv[:2] == ["systemctl", "stop"]]
                if not succeeds:
                    self.assertEqual(stops, [])
                    continue
                self.assertEqual(stops, [["systemctl", "stop", unit] for unit in sorted((DEEPSEEK, OPENAI))])
                first_stop = self.commands.index(stops[0])
                reload_at = self.commands.index(["systemctl", "daemon-reload"])
                for unit in (DEEPSEEK, OPENAI):
                    read_at = self.commands.index(["systemctl", "show", unit, "--property=TimeoutStopUSec,SendSIGKILL", "--no-pager"])
                    self.assertLess(reload_at, read_at)
                    self.assertLess(read_at, first_stop)
                self.assertTrue(any("--require-locally-idle" in argv for argv in self.commands[read_at + 1:first_stop]))
                self.assertFalse(any("kill" in argv or "--force" in argv for argv in self.commands))
                backup.check_writers_stopped(self.args.container, self.args.maintenance_directory)

        for occupied in ("existing file", "dangling link", "linked directory"):
            with self.subTest(occupied=occupied), self.runtime_directory(occupied.replace(" ", "-")) as runtime:
                self.units = copy.deepcopy(original_units)
                self.health_responses = copy.deepcopy(original_health)
                self.commands.clear()
                state_path = self.root / (occupied.replace(" ", "-") + ".json")
                target = runtime / (DEEPSEEK + ".d") / "99-video-factory-cold-stop.conf"
                if occupied == "linked directory":
                    owner_directory = runtime / "another-owner"
                    owner_directory.mkdir()
                    target.parent.symlink_to(owner_directory, target_is_directory=True)
                else:
                    target.parent.mkdir()
                    if occupied == "existing file":
                        target.write_text("other owner protection\n")
                    else:
                        target.symlink_to(runtime / "missing-owner-file")
                with self.assertRaisesRegex(cold.Error, "保护路径已被占用"):
                    cold.protect_stops(state, state_path)
                self.assertFalse(state_path.with_suffix(".stop-protection.json").exists())
                self.assertFalse((runtime / (OPENAI + ".d")).exists())
                self.assertFalse(any(argv[:2] in (["systemctl", "stop"], ["systemctl", "daemon-reload"]) for argv in self.commands))
                cold.cleanup_protections(state_path)
                if occupied == "existing file":
                    self.assertEqual(target.read_text(), "other owner protection\n")
                elif occupied == "dangling link":
                    self.assertTrue(target.is_symlink())
                    self.assertEqual(target.readlink(), runtime / "missing-owner-file")
                else:
                    self.assertTrue(target.parent.is_symlink())
                    self.assertEqual(list(owner_directory.iterdir()), [])

    def test_restored_evidence_requires_matching_candidate_stop_proof(self):
        state = self.prepared()
        self.close_ingress()
        output = self.root / "restored.json"
        proof = self.state_path.with_suffix(".rollback-stopped.json")
        with self.assertRaises((cold.Error, OSError)):
            cold.evidence(state, output, restored=True)
        self.assertFalse(output.exists())
        for invalid in (
            {"candidateRelease": PREVIOUS, "allWritersStopped": True},
            {"candidateRelease": CANDIDATE, "allWritersStopped": False},
            {"candidateRelease": CANDIDATE},
        ):
            with self.subTest(proof=invalid):
                cold.write_new(proof, invalid)
                with self.assertRaisesRegex(cold.Error, "候选写者退出证明缺失"):
                    cold.evidence(state, output, restored=True)
                self.assertFalse(output.exists())
                proof.unlink()
        self.stop_app()
        self.stop_units()
        self.container["Image"] = CANDIDATE_IMAGE
        status, stdout, stderr = self.invoke("rollback-stopped")
        self.assertEqual(status, 0, stderr)
        self.assertTrue(json.loads(stdout)["verified"])
        self.assertTrue(cold.private_json(proof)["allWritersStopped"])
        self.container["Image"] = ORIGINAL_IMAGE
        self.container["Id"] = "f" * 64
        self.container["State"].update(Running=True, Pid=456, Status="running")
        self.units[DEEPSEEK].update(ActiveState="active", SubState="running", MainPID="654")
        cold.evidence(state, output, restored=True)
        value = cold.private_json(output)
        self.assertEqual(value["kind"], "cold-abort")
        self.assertTrue(value["writersRestored"])
        self.assertTrue(value["candidateWritersStopped"])
        self.assertEqual(value["container"], {"id": "f" * 64, "image": ORIGINAL_IMAGE})

    def test_rollback_stopped_never_creates_proof_for_live_candidate_writers(self):
        self.prepared()
        self.close_ingress()
        self.container["Image"] = CANDIDATE_IMAGE
        proof = self.state_path.with_suffix(".rollback-stopped.json")
        original_container = copy.deepcopy(self.container)
        original_units = copy.deepcopy(self.units)
        for live_writer in ("app", "broker", "control process"):
            with self.subTest(live_writer=live_writer):
                self.container = copy.deepcopy(original_container)
                self.units = copy.deepcopy(original_units)
                self.stop_app()
                self.stop_units()
                if live_writer == "app":
                    self.container["State"].update(Running=True, Pid=123, Status="running")
                elif live_writer == "broker":
                    self.units[DEEPSEEK].update(ActiveState="active", SubState="running", MainPID="321")
                else:
                    self.units[OPENAI]["ControlPID"] = "987"
                status, stdout, stderr = self.invoke("rollback-stopped")
                self.assertEqual(status, 1)
                self.assertEqual(stdout, "")
                self.assertIn("写者未退出", stderr)
                self.assertFalse(proof.exists())

    def test_resolve_sources_live_mode_skips_only_exit_proof_and_default_stays_stopped(self):
        with patch.object(backup, "check_writers_stopped", wraps=backup.check_writers_stopped) as stopped:
            with self.assertRaisesRegex(backup.BackupError, "app 容器写者未退出"):
                backup.resolve_sources(self.args.container)
            self.assertEqual(stopped.call_count, 1)
            stopped.reset_mock()
            roles, source, units = backup.resolve_sources(self.args.container, require_stopped=False)
            stopped.assert_not_called()
            self.assertEqual(set(units), set(self.units))
            self.assertTrue(source["writers"]["containerRunning"])
            self.assertEqual(source["image"], ORIGINAL_IMAGE)
            self.assertEqual({role["unit"] for role in roles if role["role"] == "broker-workspace"}, {DEEPSEEK, OPENAI})
            env_file = self.root / (OPENAI + ".env")
            contents = env_file.read_text()
            env_file.write_text(contents.replace(str(self.root / (OPENAI + "-workspace")), str(self.root / "missing-root")))
            with self.assertRaisesRegex(backup.BackupError, "broker 工作根不存在"):
                backup.resolve_sources(self.args.container, require_stopped=False)
            stopped.assert_not_called()
            env_file.write_text(contents)
            self.stop_app()
            self.stop_units()
            stopped_roles, stopped_source, _ = backup.resolve_sources(self.args.container)
            self.assertEqual(stopped.call_count, 1)
            self.assertEqual(stopped_roles, roles)
            self.assertFalse(stopped_source["writers"]["containerRunning"])

    def test_cold_verifier_limits_stopped_exemption_to_originally_inactive_units(self):
        state = self.prepared()
        self.close_ingress()
        self.stop_app()
        self.stop_units()
        output = self.root / "stopped.json"
        self.commands.clear()
        cold.evidence(state, output)
        value = cold.private_json(output)
        self.assertTrue(value["writersStopped"])
        self.assertEqual(value["integrity"], {"complete": True, "quiescent": True})
        verifier_commands = [argv for argv in self.commands if "/app/scripts/verify-production-backup.mjs" in argv]
        self.assertEqual(len(verifier_commands), 3)
        for argv in verifier_commands:
            self.assertIn(CANDIDATE_IMAGE, argv)
            self.assertEqual(argv[argv.index("--require-locally-idle") + 1], "true")
            self.assertEqual(argv[argv.index("--network") + 1], "none")
            self.assertIn("--read-only", argv)
            self.assertEqual(argv[argv.index("--user") + 1], "1001:1001")
            role = next(role for role in state["roles"] if role["logical"] == argv[argv.index("--root") + 1])
            self.assertEqual("--writer-stopped" in argv, role.get("unit") == OPENAI)
            self.assertEqual("--allow-legacy" in argv, role["role"] == "broker-workspace")
            for flag in ("--writer-stopped", "--allow-legacy"):
                if flag in argv:
                    self.assertEqual(argv[argv.index(flag) + 1], "true")
        for invalid in ({"complete": True}, {"complete": True, "localQuiescent": False}):
            with self.subTest(report=invalid):
                self.verifier_value = invalid
                with self.assertRaisesRegex(backup.BackupError, "报告不完整"):
                    cold.strict_report(state, state["roles"])

        self.verifier_value = {"complete": True, "localQuiescent": True}
        cgroup_root = self.root / "cgroup"
        child = cgroup_root / "fixture" / "child"
        child.mkdir(parents=True)
        (child.parent / "cgroup.procs").write_text("")
        (child / "cgroup.procs").write_text("456\n")
        self.units[OPENAI]["ControlGroup"] = "/fixture"

        def local_cgroup_path(value):
            target = Path(value)
            system_cgroup = Path("/sys/fs/cgroup")
            if target.is_relative_to(system_cgroup):
                return cgroup_root / target.relative_to(system_cgroup)
            return target

        self.commands.clear()
        with patch.object(backup, "Path", side_effect=local_cgroup_path):
            with self.assertRaisesRegex(backup.BackupError, "cgroup 写者未退出"):
                cold.strict_report(state, state["roles"])
        self.assertFalse(any("/app/scripts/verify-production-backup.mjs" in argv for argv in self.commands))

    def test_backup_require_idle_still_demands_quiescent_and_legacy_is_explicit(self):
        state = self.prepared()
        self.commands.clear()
        backup.verifier_report(CANDIDATE_IMAGE, state["roles"], require_idle=True)
        verifier_commands = [argv for argv in self.commands if "/app/scripts/verify-production-backup.mjs" in argv]
        self.assertEqual(len(verifier_commands), 3)
        for argv in verifier_commands:
            self.assertEqual(argv[argv.index("--require-idle") + 1], "true")
            self.assertNotIn("--allow-legacy", argv)
            self.assertNotIn("--writer-stopped", argv)
        for invalid in ({"complete": True}, {"complete": True, "quiescent": False}):
            with self.subTest(report=invalid):
                self.verifier_value = invalid
                with self.assertRaisesRegex(backup.BackupError, "报告不完整"):
                    backup.verifier_report(CANDIDATE_IMAGE, state["roles"], require_idle=True)
        self.verifier_value = {"complete": True}
        self.commands.clear()
        backup.verifier_report(CANDIDATE_IMAGE, state["roles"])
        for argv in self.commands:
            for flag in ("--require-idle", "--require-locally-idle", "--allow-legacy", "--writer-stopped"):
                self.assertNotIn(flag, argv)

    def test_outputs_are_private_exclusive_and_reject_nonprivate_or_symlink_reads(self):
        output = self.root / "private-output.json"
        cold.write_new(output, {"candidateRelease": CANDIDATE})
        contents = output.read_bytes()
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.assertEqual(cold.private_json(output), {"candidateRelease": CANDIDATE})
        with self.assertRaises(FileExistsError):
            cold.write_new(output, {"candidateRelease": PREVIOUS})
        self.assertEqual(output.read_bytes(), contents)
        output.chmod(0o644)
        with self.assertRaisesRegex(cold.Error, "身份或权限无效"):
            cold.private_json(output)
        output.chmod(0o600)
        link = self.root / "linked-output.json"
        link.symlink_to(output)
        with self.assertRaisesRegex(cold.Error, "身份或权限无效"):
            cold.private_json(link)
        with self.assertRaises(FileExistsError):
            cold.write_new(link, {})
        self.assertEqual(output.read_bytes(), contents)


if __name__ == "__main__":
    unittest.main()
