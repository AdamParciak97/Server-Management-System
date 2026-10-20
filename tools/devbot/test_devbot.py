"""Exercise real child processes and supervisor transitions without spending tokens."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import devbot


FAKE_AGENT = '''import json, pathlib, sys
prompt = sys.stdin.read()
assert "BACKLOG.md" in prompt
pathlib.Path(sys.argv[1]).write_text("Zmieniono kod, potrzebne testy.", encoding="utf-8")
print(json.dumps({"type": "thread.started", "thread_id": "fake-thread"}))
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 12, "output_tokens": 4}}))
'''


class BotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.config = devbot.load_config(devbot.HERE / "config.json")
        self.config["preview_enabled"] = False
        self.bot = devbot.Bot(self.config, self.directory)

    def fake_command(self, config, report):
        return [sys.executable, "-c", FAKE_AGENT, str(report)]

    def test_success_requires_independent_tests(self):
        with patch.object(devbot, "codex_command", self.fake_command), patch.object(
            devbot, "test_commands", return_value=[[sys.executable, "-c", "print('tests passed')"]]
        ):
            self.bot.cycle()
        self.assertEqual(self.bot.state["status"], "ready")
        self.assertEqual(self.bot.state["last_tests"][0]["exit_code"], 0)
        self.assertEqual(self.bot.state["last_usage"]["input_tokens"], 12)
        self.assertTrue(Path(self.bot.state["last_report"]).exists())

    def test_failing_test_cannot_be_reported_as_success(self):
        with patch.object(devbot, "codex_command", self.fake_command), patch.object(
            devbot, "test_commands", return_value=[[sys.executable, "-c", "raise SystemExit(1)"]]
        ):
            self.bot.cycle()
        self.assertEqual(self.bot.state["status"], "waiting_error")
        self.assertEqual(self.bot.state["last_tests"][0]["exit_code"], 1)
        self.assertIn("last_tests", devbot.prompt_for(self.bot.state))

    def test_preview_only_updates_after_passing_tests(self):
        self.config['preview_enabled'] = True
        with patch.object(devbot, 'codex_command', self.fake_command), patch.object(
            devbot, 'test_commands', return_value=[[sys.executable, '-c', 'raise SystemExit(1)']]
        ), patch.object(self.bot, 'refresh_preview') as refresh:
            self.bot.cycle()
            refresh.assert_not_called()
        with patch.object(devbot, 'codex_command', self.fake_command), patch.object(
            devbot, 'test_commands', return_value=[[sys.executable, '-c', 'pass']]
        ), patch.object(self.bot, 'refresh_preview', return_value=True) as refresh:
            self.bot.cycle()
            refresh.assert_called_once()
            self.assertEqual(self.bot.state['status'], 'ready')

    def test_failed_preview_keeps_previous_revision(self):
        revision = self.directory / 'preview.json'
        devbot.atomic_json(revision, {'revision': 'previous'})
        with patch.object(devbot, 'run_process', return_value=('finished', 1)):
            self.assertFalse(self.bot.refresh_preview())
        self.assertEqual(devbot.read_json(revision)['revision'], 'previous')
        self.assertEqual(self.bot.state['preview']['status'], 'error')

    def test_successful_preview_publishes_revision(self):
        with patch.object(devbot, 'run_process', return_value=('finished', 0)):
            self.assertTrue(self.bot.refresh_preview())
        self.assertTrue(devbot.read_json(self.directory / 'preview.json')['revision'])

    def test_limit_then_restart_then_recovery(self):
        code = 'import json; print(json.dumps({"type":"turn.failed","error":{"message":"usage limit reached"}})); raise SystemExit(1)'
        with patch.object(devbot, "codex_command", return_value=[sys.executable, "-c", code]):
            self.bot.cycle()
        self.assertEqual(self.bot.state["status"], "waiting_limit")
        resumed = devbot.Bot(self.config, self.directory)
        with patch.object(resumed, "cycle") as cycle:
            resumed.run(once=True)
        cycle.assert_not_called()
        resumed.save(next_run_at=0)
        with patch.object(devbot, "codex_command", self.fake_command), patch.object(
            devbot, "test_commands", return_value=[[sys.executable, "-c", "pass"]]
        ):
            resumed.run(once=True)
        self.assertEqual(resumed.state["status"], "ready")
        self.assertEqual(resumed.state["limit_attempts"], 0)

    def test_limit_retries_do_not_exhaust_error_budget(self):
        for _ in range(8):
            self.bot.schedule("limit", "rate limit exceeded")
        self.assertEqual(self.bot.state["status"], "waiting_limit")
        self.assertEqual(self.bot.state["consecutive_errors"], 0)
        self.assertLessEqual(self.bot.state["next_run_at"] - time.time(), 3600)

    def test_auth_and_billing_block_instead_of_repeating(self):
        for message in ("Not logged in", "refresh_token expired", "insufficient_quota"):
            self.bot.schedule(devbot.failure_kind(message), message)
            self.assertEqual(self.bot.state["status"], "blocked")

    def test_repeated_unknown_errors_block(self):
        for _ in range(self.config["max_consecutive_errors"]):
            self.bot.schedule("error", "Invalid configuration")
        self.assertEqual(self.bot.state["status"], "blocked")

    def test_protocol_parser_ignores_quoted_errors(self):
        path = self.directory / "events.jsonl"
        path.write_text('\n'.join([
            'garbled', 'null', '[]',
            json.dumps({"type": "item.completed", "item": {"text": "usage limit reached"}}),
            json.dumps({"type": "turn.completed", "usage": {"output_tokens": 7}}),
        ]), encoding="utf-8")
        complete, error, usage, _ = devbot.inspect_events(path)
        self.assertTrue(complete)
        self.assertEqual(error, "")
        self.assertEqual(usage["output_tokens"], 7)

    def test_exit_zero_without_completion_is_failure(self):
        with patch.object(devbot, "codex_command", return_value=[sys.executable, "-c", "pass"]):
            self.bot.cycle()
        self.assertEqual(self.bot.state["status"], "waiting_error")

    def test_server_retry_hints_are_respected(self):
        self.assertEqual(devbot.retry_delay('try again in 2 hours', 1, self.config, 1000), 7205)
        self.assertEqual(devbot.retry_delay('{"resets_at": 20000}', 1, self.config, 1000), 19030)
        self.assertEqual(devbot.retry_delay('retry after 500 ms', 1, self.config, 1000), 900)

    def test_process_timeout(self):
        result = devbot.run_process([sys.executable, "-c", "import time; time.sleep(20)"],
                                    self.directory, self.directory / "timeout", 0.1,
                                    self.directory / "STOP")
        self.assertEqual(result, ("timeout", -1))

    def test_stop_terminates_child(self):
        self.bot.stop_file.touch()
        result = devbot.run_process([sys.executable, "-c", "import time; time.sleep(20)"],
                                    self.directory, self.directory / "stop", 20, self.bot.stop_file)
        self.assertEqual(result, ("stopped", -1))

    def test_lock_prevents_second_process_and_releases(self):
        lock = self.directory / "bot.lock"
        with devbot.single_instance(lock):
            result = subprocess.run([sys.executable, "-c",
                "import devbot, pathlib, sys\nwith devbot.single_instance(pathlib.Path(sys.argv[1])): pass",
                str(lock)], cwd=devbot.HERE, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
        with devbot.single_instance(lock):
            pass

    def test_crash_during_testing_resumes_test_gate(self):
        folder = self.directory / "interrupted"
        folder.mkdir()
        self.bot.save(status="testing", active_run=str(folder))
        resumed = devbot.Bot(self.config, self.directory)
        with patch.object(devbot, "test_commands", return_value=[[sys.executable, "-c", "pass"]]), patch.object(
            resumed, "cycle"
        ) as cycle:
            resumed.run(once=True)
        cycle.assert_not_called()
        self.assertEqual(resumed.state["status"], "ready")

    def test_workspace_sandbox_and_chatgpt_auth_are_explicit(self):
        command = devbot.codex_command(self.config, self.directory / "report.md")
        self.assertIn("workspace-write", command)
        self.assertIn('forced_login_method="chatgpt"', command)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", command)
        with patch.dict(devbot.os.environ, {"OPENAI_API_KEY": "fake", "CODEX_API_KEY": "fake"}):
            env = devbot.child_environment()
        self.assertNotIn("CODEX_API_KEY", env)
        self.assertNotIn("OPENAI_API_KEY", env)


if __name__ == "__main__":
    unittest.main()
