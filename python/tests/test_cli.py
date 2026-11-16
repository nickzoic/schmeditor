"""The command line: non-interactive checks. (Runs in a pseudo-terminal: test_cli_terminal.py.)"""
import subprocess
import sys
from pathlib import Path

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


def schmeditor(*args, **kwargs):
    return subprocess.run([sys.executable, "-m", "schmeditor", *args], capture_output=True, text=True, **kwargs)


def test_check_reports_validity_through_the_exit_status():
    ok = schmeditor(str(EXAMPLES / "contact.schema.json"), str(EXAMPLES / "contact.json"), "--check")
    assert ok.returncode == 0 and ok.stdout == ""
    ok = schmeditor(str(EXAMPLES / "editor-metaschema.json"), str(EXAMPLES / "contact.schema.json"), "--check")
    assert ok.returncode == 0


def test_check_lists_errors(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text('{"tags": []}')
    r = schmeditor(str(EXAMPLES / "contact.schema.json"), str(bad), "--check")
    assert r.returncode == 1
    assert 'Missing required property "name"' in r.stdout and "at least 1 items" in r.stdout


def test_clear_errors_for_bad_input(tmp_path):
    r = schmeditor(str(tmp_path / "nope.json"))
    assert r.returncode != 0 and "nope.json" in r.stderr
    broken = tmp_path / "broken.json"
    broken.write_text("{oops")
    r = schmeditor(str(broken))
    assert r.returncode != 0 and "not valid JSON" in r.stderr
    r = schmeditor(str(EXAMPLES / "contact.schema.json"), stdin=subprocess.DEVNULL)
    assert r.returncode != 0 and "-o" in r.stderr           # stdout is not a terminal
