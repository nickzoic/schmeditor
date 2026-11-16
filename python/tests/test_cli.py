"""The command line: non-interactive checks, and a real run in a pseudo-terminal."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

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


pexpect = pytest.importorskip("pexpect", reason="pexpect is needed to drive a pseudo-terminal")
pyte = pytest.importorskip("pyte", reason="pyte is needed to read the pseudo-terminal screen")
pytestmark_posix = pytest.mark.skipif(sys.platform == "win32", reason="needs a POSIX pseudo-terminal")

CTRL_S, CTRL_Q, ENTER, ESC, DOWN = "\x13", "\x11", "\r", "\x1b", "\x1b[B"


class Terminal:
    def __init__(self, *args, cwd):
        self.screen = pyte.Screen(130, 40)
        self.stream = pyte.Stream(self.screen)
        self.child = pexpect.spawn(sys.executable, ["-m", "schmeditor", *args], cwd=str(cwd),
                                   dimensions=(40, 130), timeout=15,
                                   env={**os.environ, "TERM": "xterm-256color"})
        self.pump(1.5)

    def pump(self, seconds=0.5):
        time.sleep(seconds)
        try:
            while True:
                self.stream.feed(self.child.read_nonblocking(1 << 16, timeout=0.2).decode(errors="replace"))
        except Exception:
            pass

    def send(self, keys, wait=0.4):
        self.child.send(keys)
        self.pump(wait)

    def text(self):
        return "\n".join(line.rstrip() for line in self.screen.display)

    def wait_for(self, needle, seconds=6):
        end = time.time() + seconds
        while time.time() < end:
            self.pump(0.2)
            if needle in self.text():
                return True
        return False

    def finish(self):
        self.child.expect(pexpect.EOF, timeout=10)
        self.child.close()
        return self.child.exitstatus


@pytestmark_posix
def test_edit_and_save_a_file_in_a_terminal(tmp_path):
    schema = tmp_path / "schema.json"
    schema.write_text((EXAMPLES / "contact.schema.json").read_text())
    doc = tmp_path / "doc.json"
    doc.write_text((EXAMPLES / "contact.json").read_text())

    term = Terminal("schema.json", "doc.json", cwd=tmp_path)
    assert term.wait_for('name: "Ada"')
    term.send(DOWN)
    term.send(ENTER)
    term.send("Grace")
    term.send(ESC, 0.6)
    term.send(CTRL_S, 0.8)
    assert term.wait_for("Saved to doc.json")
    term.send(CTRL_Q)
    assert term.finish() == 0
    saved = json.loads(doc.read_text())
    assert saved["name"] == "Grace" and saved["tags"] == ["math", "engines"]


@pytestmark_posix
def test_output_option_and_new_documents(tmp_path):
    (tmp_path / "schema.json").write_text((EXAMPLES / "contact.schema.json").read_text())
    term = Terminal("schema.json", "new.json", cwd=tmp_path)
    term.send(CTRL_S, 0.8)
    term.send(CTRL_Q)
    assert term.finish() == 0
    assert json.loads((tmp_path / "new.json").read_text()) == {"name": "Unnamed", "tags": ["x"]}


@pytestmark_posix
def test_discarding_changes_leaves_the_file_alone(tmp_path):
    (tmp_path / "schema.json").write_text((EXAMPLES / "contact.schema.json").read_text())
    doc = tmp_path / "doc.json"
    doc.write_text((EXAMPLES / "contact.json").read_text())
    before = doc.read_text()
    term = Terminal("schema.json", "doc.json", cwd=tmp_path)
    term.send(DOWN)
    term.send(ENTER)
    term.send("Zed")
    term.send(ESC, 0.6)
    term.send(CTRL_Q, 0.8)
    assert term.wait_for("unsaved changes")
    term.send("\t")                                       # Save -> Discard
    term.send(ENTER, 0.5)
    assert term.finish() == 1
    assert doc.read_text() == before
