import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("routes", Path(__file__).resolve().parents[1] / "scripts/refresh-domestic-routes.py")
routes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routes)


class DomesticRoutesTest(unittest.TestCase):
    def test_only_adds_public_host_routes_and_keeps_overseas_default(self):
        with patch.object(routes, "direct_route", return_value=["via", "172.27.95.253", "dev", "eth0", "src", "172.27.86.223", "metric", "49"]), \
                patch.object(routes, "public_addresses", return_value=["8.131.131.246"]), \
                patch.object(routes.subprocess, "run") as run:
            self.assertEqual(routes.refresh(["dashscope-a717.oss-accelerate.aliyuncs.com"]), 0)
            run.assert_not_called()
            self.assertEqual(routes.refresh(["dashscope-a717.oss-accelerate.aliyuncs.com"], apply=True), 0)
            self.assertEqual(run.call_args.args[0], ["ip", "-4", "route", "replace", "8.131.131.246/32", "via", "172.27.95.253", "dev", "eth0", "src", "172.27.86.223", "metric", "49"])

    def test_private_dns_is_not_installed(self):
        with patch.object(routes.subprocess, "check_output", return_value="127.0.0.1 STREAM example\n"):
            with self.assertRaises(ValueError):
                routes.public_addresses("dashscope.aliyuncs.com")

    def test_ambiguous_gateway_does_not_modify_routes(self):
        with patch.object(routes.subprocess, "check_output", return_value='[{"gateway":"10.8.0.1","dev":"tun0","prefsrc":"10.8.0.2"}]'):
            with self.assertRaises(ValueError):
                routes.direct_route()

    def test_failed_lookup_preserves_routes_and_continues_other_hosts(self):
        with patch.object(routes, "direct_route", return_value=[]), \
                patch.object(routes, "public_addresses", side_effect=[subprocess.TimeoutExpired("getent", 5), ["8.131.131.246"]]), \
                patch.object(routes.subprocess, "run") as run:
            self.assertEqual(routes.refresh(["unavailable.example", "dashscope.aliyuncs.com"], apply=True), 1)
            self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
