"""The Textual user interface: a tree of the document, a panel that edits the selected item,
and the dialogs that go with them."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Optional

from rich.text import Text
from textual import events, on
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import (Button, Footer, Header, Input, Label, OptionList, Select, Static, Switch,
                             TextArea, Tree)
from textual.widgets.option_list import Option

from .engine import (_MISSING, ALL_TYPES, _dumps, _num, clone, deep_equal, get_at, is_type, parse_path,
                     to_ptr, type_of)
from .model import SchemaEditor

__all__ = ["EditorApp"]



# ----------------------------------------------------------------------------------- TUI

@dataclass(frozen=True)
class Ref:
    """What a tree node stands for."""
    path: tuple
    ghost: bool = False        # a required property that is missing from the document
    kind: str = "leaf"         # "obj", "arr" or "leaf"


class PromptScreen(ModalScreen[Optional[str]]):
    """Ask for a line of text."""

    BINDINGS = [Binding("escape", "cancel", "Cancel")]
    DEFAULT_CSS = """
    PromptScreen { align: center middle; }
    PromptScreen > Vertical { width: 60; max-width: 95%; height: auto; border: thick $primary;
                              background: $surface; padding: 1 2; }
    PromptScreen .err { color: $error; height: auto; }
    PromptScreen Horizontal { height: auto; margin-top: 1; }
    PromptScreen Button { margin-right: 2; }
    """

    def __init__(self, title: str, value: str = "", placeholder: str = ""):
        super().__init__()
        self._title, self._value, self._placeholder = title, value, placeholder

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Label(Text(self._title, style="bold"))
            yield Input(self._value, placeholder=self._placeholder, id="prompt-input")
            with Horizontal():
                yield Button("OK", variant="primary", id="ok")
                yield Button("Cancel", id="cancel")

    def on_mount(self) -> None:
        box = self.query_one(Input)
        box.focus()
        box.select_all()

    @on(Input.Submitted)
    def _submitted(self, event: Input.Submitted) -> None:
        self.dismiss(event.value)

    @on(Button.Pressed)
    def _pressed(self, event: Button.Pressed) -> None:
        self.dismiss(self.query_one(Input).value if event.button.id == "ok" else None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class PickScreen(ModalScreen[Optional[int]]):
    """Choose from a list. Typing filters it."""

    BINDINGS = [Binding("escape", "cancel", "Cancel")]
    DEFAULT_CSS = """
    PickScreen { align: center middle; }
    PickScreen > Vertical { width: 64; max-width: 95%; height: auto; max-height: 85%; border: thick $primary;
                            background: $surface; padding: 1 2; }
    PickScreen OptionList { height: auto; max-height: 16; margin-top: 1; }
    """

    def __init__(self, title: str, options: list[tuple[str, str]]):
        super().__init__()
        self._title, self._options = title, options        # [(label, description)]

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Label(Text(self._title, style="bold"))
            yield Input(placeholder="Type to filter, ↓ to choose, Enter to accept", id="pick-filter")
            yield OptionList(id="pick-list")

    def on_mount(self) -> None:
        self._fill("")

    def _fill(self, query: str) -> None:
        ol = self.query_one(OptionList)
        ol.clear_options()
        q = query.lower()
        items = []
        for i, (label, desc) in enumerate(self._options):
            if q in label.lower():
                t = Text(label)
                if desc:
                    t.append("  " + (desc if len(desc) <= 34 else desc[:33] + "…"), style="dim")
                items.append(Option(t, id=str(i)))
        ol.add_options(items)
        if items:
            ol.highlighted = 0

    @on(Input.Changed, "#pick-filter")
    def _filter(self, event: Input.Changed) -> None:
        self._fill(event.value)

    @on(Input.Submitted, "#pick-filter")
    def _accept(self) -> None:
        ol = self.query_one(OptionList)
        if ol.highlighted is not None and ol.option_count:
            self.dismiss(int(ol.get_option_at_index(ol.highlighted).id))

    @on(OptionList.OptionSelected)
    def _selected(self, event: OptionList.OptionSelected) -> None:
        self.dismiss(int(event.option.id))

    def on_key(self, event: events.Key) -> None:
        if event.key == "down" and isinstance(self.focused, Input):
            self.query_one(OptionList).focus()
            event.stop()

    def action_cancel(self) -> None:
        self.dismiss(None)


class ConfirmScreen(ModalScreen[str]):
    """A message and a few buttons; returns the id of the button pressed ('' if dismissed)."""

    BINDINGS = [Binding("escape", "dismiss_none", "Cancel")]
    DEFAULT_CSS = """
    ConfirmScreen { align: center middle; }
    ConfirmScreen > Vertical { width: 64; max-width: 95%; height: auto; border: thick $warning;
                               background: $surface; padding: 1 2; }
    ConfirmScreen Horizontal { height: auto; margin-top: 1; }
    ConfirmScreen Button { margin-right: 2; }
    """

    def __init__(self, message: str, buttons: list[tuple[str, str, str]]):
        super().__init__()
        self._message, self._buttons = message, buttons      # [(label, id, variant)]

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static(Text(self._message))
            with Horizontal():
                for label, bid, variant in self._buttons:
                    yield Button(label, id=bid, variant=variant)  # type: ignore[arg-type]

    @on(Button.Pressed)
    def _pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id or "")

    def action_dismiss_none(self) -> None:
        self.dismiss("")


HELP = """\
Move around the tree with the arrow keys. The panel on the right edits the selected item.

  Enter      edit the value (strings, numbers, choices) or expand/collapse
  Esc        back to the tree
  a          add a property or array item (inside the selected container)
  d          delete the selected property or item        Delete also works
  r          rename the selected property
  K / J      move the selected array item up / down
  e          edit the selected value (toggles true/false)
  Ctrl+Z     undo      Ctrl+Y   redo
  Ctrl+S     save (or, when used as a library, finish and return the document)
  Ctrl+Q     quit
  Tab        move between the tree and the panel

Every edit is checked against the schema. An edit that would add a validation error is
refused, and the reason is shown, so a valid document always stays valid.
✗ marks items that contain errors. Items shown in italics are required but missing.
"""


class HelpScreen(ModalScreen[None]):
    BINDINGS = [Binding("escape,enter,f1,q", "close", "Close")]
    DEFAULT_CSS = """
    HelpScreen { align: center middle; }
    HelpScreen > Vertical { width: 84; max-width: 95%; height: auto; max-height: 90%; border: thick $primary;
                            background: $surface; padding: 1 2; }
    """

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static(Text(HELP))

    def action_close(self) -> None:
        self.dismiss(None)


class DocTree(Tree[Ref]):
    """The document as a tree. Its key bindings only apply while it has focus."""

    BINDINGS = [
        Binding("a", "app.add", "Add"),
        Binding("d,delete", "app.remove", "Delete"),
        Binding("r", "app.rename", "Rename"),
        Binding("K", "app.move_up", "Move up"),
        Binding("J", "app.move_down", "Move down"),
        Binding("e", "app.edit", "Edit"),
    ]


class Detail(VerticalScroll):
    """The panel that edits the selected node. Rebuilt with `refresh(recompose=True)`."""

    def compose(self) -> ComposeResult:
        yield from self.app.detail_widgets()          # type: ignore[attr-defined]


def _compact(v: Any, limit: int = 60) -> str:
    text = _dumps(v)
    return text if len(text) <= limit else text[: limit - 1] + "…"


class EditorApp(App[Optional[tuple]]):
    TITLE = "Schema editor"
    ENABLE_COMMAND_PALETTE = False
    CSS = """
    #main { height: 1fr; }
    #tree { width: 5fr; border: round $primary; padding: 0 1; }
    #detail { width: 6fr; border: round $secondary; padding: 0 1; }
    #detail Static { height: auto; margin-bottom: 1; }
    #detail Select, #detail Input { margin-bottom: 1; }
    #detail Switch { margin-bottom: 1; }
    #detail TextArea { height: 8; margin-bottom: 1; }
    #detail .buttons { height: auto; }
    #detail .buttons Button { margin-right: 1; }
    #status { height: 1; padding: 0 1; background: $boost; }
    """
    BINDINGS = [
        Binding("ctrl+s", "save", "Save", priority=True),
        Binding("ctrl+q", "quit_app", "Quit", priority=True),
        Binding("ctrl+z", "undo", "Undo"),
        Binding("ctrl+y", "redo", "Redo"),
        Binding("f1", "help", "Help"),
        Binding("escape", "focus_tree", "Tree", show=False),
    ]

    def __init__(self, editor: SchemaEditor, save_handler: Optional[Callable[[Any], Optional[str]]] = None,
                 subtitle: str = ""):
        super().__init__()
        self.ed = editor
        self.save_handler = save_handler
        self.current = Ref(())
        self._exp: dict[str, bool] = {}
        self._bad: set[str] = set()
        self.title = editor.title or (editor.schema.get("title") if isinstance(editor.schema, dict) else None) \
            or "Schema editor"
        self.sub_title = subtitle

    # ---- layout --------------------------------------------------------------------

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="main"):
            yield DocTree(Text("document"), data=Ref(()), id="tree")
            yield Detail(id="detail")
        yield Static(id="status")
        yield Footer()

    @property
    def tree(self) -> DocTree:
        return self.query_one(DocTree)

    def on_mount(self) -> None:
        self.tree.show_root = True
        self._rebuild_tree()
        self.tree.focus()
        self._show_detail()

    # ---- tree construction -----------------------------------------------------------

    def _kind(self, value: Any) -> str:
        return "obj" if isinstance(value, dict) else "arr" if isinstance(value, list) else "leaf"

    def _expected(self, path: tuple) -> list[Ref]:
        """The children a container node should have, in display order."""
        value, s, _ = self.ed.info(path)
        if isinstance(value, list):
            return [Ref(path + (i,), False, self._kind(v)) for i, v in enumerate(value)]
        if not isinstance(value, dict):
            return []
        props = s["properties"] if isinstance(s.get("properties"), dict) else {}
        req = list(s["required"]) if isinstance(s.get("required"), list) else []
        out: list[Ref] = []
        seen: set[str] = set()
        for k in props:
            if k in value:
                out.append(Ref(path + (k,), False, self._kind(value[k])))
                seen.add(k)
            elif k in req and self.ed.prop_schema(s, k) is not None:
                out.append(Ref(path + (k,), True, "leaf"))
                seen.add(k)
        for k, v in value.items():
            if k not in seen:
                out.append(Ref(path + (k,), False, self._kind(v)))
                seen.add(k)
        for k in req:
            if k not in seen and self.ed.prop_schema(s, k) is not None:
                out.append(Ref(path + (k,), True, "leaf"))
                seen.add(k)
        return out

    def _label(self, ref: Ref) -> Text:
        path = ref.path
        doc = self.ed.document
        t = Text()
        parent = get_at(doc, path[:-1]) if path else None
        if not path:
            t.append("document", style="bold")
        elif isinstance(parent, list):
            t.append(f"[{path[-1]}]", style="bold")
        else:
            t.append(str(path[-1]), style="italic dim" if ref.ghost else "bold")
        if ref.ghost:
            t.append("  required, missing: press Enter to add", style="dim red")
            return t
        value = get_at(doc, path)
        if isinstance(value, dict):
            t.append(f" {{{len(value)}}}", style="dim")
        elif isinstance(value, list):
            t.append(f" [{len(value)}]", style="dim")
        else:
            t.append(": ")
            if isinstance(value, str):
                t.append(_compact(value, 48), style="green")
            elif isinstance(value, bool):
                t.append("true" if value else "false", style="magenta")
            elif value is None:
                t.append("null", style="dim")
            else:
                t.append(_dumps(value), style="cyan")
        if to_ptr(path) in self._bad:
            t.append(" ✗", style="bold red")
        return t

    def _populate(self, tnode: Any, path: tuple, depth: int) -> None:
        tnode.remove_children()
        kids = self._expected(path)
        for ref in kids:
            label = self._label(ref)
            if ref.kind == "leaf":
                tnode.add_leaf(label, data=ref)
            else:
                child = tnode.add(label, data=ref, expand=self._exp.get(to_ptr(ref.path), depth < 2), allow_expand=False)
                self._populate(child, ref.path, depth + 1)
        tnode.allow_expand = bool(kids)

    def _rebuild_tree(self) -> None:
        self._refresh_bad()
        root = self.tree.root
        root.data = Ref((), False, self._kind(self.ed.document))
        self._populate(root, (), 0)
        root.set_label(self._label(root.data))
        root.expand()

    def _refresh_bad(self) -> None:
        bad: set[str] = set()
        for e in self.ed.validate():
            parts = parse_path(e["path"])
            for i in range(len(parts) + 1):
                bad.add(to_ptr(parts[:i]))
        self._bad = bad

    def _walk(self, node: Any):
        yield node
        for c in node.children:
            yield from self._walk(c)

    def _find_node(self, path) -> Any:
        """The tree node for `path`, or its nearest existing ancestor."""
        node = self.tree.root
        for k in path:
            nxt = next((c for c in node.children if c.data is not None and str(c.data.path[-1]) == str(k)), None)
            if nxt is None:
                break
            node = nxt
        return node

    def _move_cursor(self, node: Any) -> None:
        """Move the tree cursor to `node`. Textual only recomputes line numbers lazily, so after
        the tree has been rebuilt we first ask it for a line, which forces that."""
        self.tree.get_node_at_line(0)
        self.tree.move_cursor(node)

    def _sync(self, changed: tuple = ()) -> None:
        """Bring the tree up to date after an edit at `changed`."""
        old_bad = self._bad
        self._refresh_bad()
        # Only the nodes on the way to the change (and the changed node itself) can change shape.
        node = self.tree.root
        path: tuple = ()
        depth = 0
        while True:
            node.data = Ref(path, node.data.ghost if node.data else False, self._kind(get_at(self.ed.document, path)))
            want = self._expected(path)
            have = [c.data for c in node.children]
            if want != have:
                self._populate(node, path, depth)
                break
            if len(path) >= len(changed):
                break
            nxt = next((c for c in node.children if str(c.data.path[-1]) == str(changed[len(path)])), None)
            if nxt is None:
                break
            node, path, depth = nxt, nxt.data.path, depth + 1
        # Relabel only what can have changed: the edited node and its ancestors (their counts),
        # everything below an edited container, and nodes whose error marker flipped.
        stale: dict[int, Any] = {}
        for ptr in old_bad ^ self._bad:
            n = self._find_node(parse_path(ptr))
            stale[id(n)] = n
        for i in range(len(changed) + 1):
            n = self._find_node(changed[:i])
            stale[id(n)] = n
        edited = self._find_node(changed)
        if edited.data is not None and edited.data.path == changed:
            for n in self._walk(edited):
                stale[id(n)] = n
        for n in stale.values():
            if n.data is not None:
                n.set_label(self._label(n.data))
        # Rebuilding can shift lines under the cursor: put it back on the node being edited.
        node = self._find_node(self.current.path)
        if node.data is not None and node.data.path == self.current.path:
            self.current = node.data
            self.tree.get_node_at_line(0)
            if self.tree.cursor_node is not node:
                self._move_cursor(node)
        self._update_status()

    def _update_status(self) -> None:
        errs = self.ed.validate()
        t = Text()
        t.append(to_ptr(self.current.path) or "/", style="bold")
        t.append("   ")
        if errs:
            t.append(f"✗ {len(errs)} error{'s' if len(errs) != 1 else ''}", style="bold red")
        else:
            t.append("✓ valid", style="bold green")
        if self.ed.modified:
            t.append("   ● modified", style="yellow")
        if self.save_handler is None:
            t.append("   Ctrl+S: finish and return", style="dim")
        self.query_one("#status", Static).update(t)

    def _after_change(self, changed: tuple = (), recompose: bool = False) -> None:
        self._sync(changed)
        self._update_errors_widget()
        if recompose:
            self._show_detail()

    # ---- selection ---------------------------------------------------------------------

    def _show_detail(self) -> None:
        self.query_one(Detail).refresh(recompose=True)
        self._update_status()

    def _select_path(self, path, focus_tree: bool = True) -> None:
        node = self._find_node(path)
        n = node.parent
        while n is not None:
            n.expand()
            n = n.parent
        self._move_cursor(node)
        self.current = node.data
        self.ed.break_undo()
        self._show_detail()
        if focus_tree:
            self.tree.focus()

    @on(Tree.NodeHighlighted)
    def _highlighted(self, event: Tree.NodeHighlighted) -> None:
        ref = event.node.data
        # Rebuilding the tree resets its cursor and queues stale events: only follow the real cursor.
        if not self.tree.has_focus or event.node is not self.tree.cursor_node:
            return
        if ref is None or ref == self.current:
            return
        self.current = ref
        self.ed.break_undo()
        self._show_detail()

    @on(Tree.NodeExpanded)
    def _expanded(self, event: Tree.NodeExpanded) -> None:
        if event.node.data is not None:
            self._exp[to_ptr(event.node.data.path)] = True

    @on(Tree.NodeCollapsed)
    def _collapsed(self, event: Tree.NodeCollapsed) -> None:
        if event.node.data is not None:
            self._exp[to_ptr(event.node.data.path)] = False

    @on(Tree.NodeSelected)
    def _selected(self, event: Tree.NodeSelected) -> None:
        ref = event.node.data
        if ref is None:
            return
        if ref != self.current:
            self.current = ref
            self._show_detail()
        if ref.ghost:
            self.action_edit()
        elif ref.kind == "leaf":
            self._focus_editor()

    # ---- the detail panel --------------------------------------------------------------

    def _constraints(self, s: dict) -> str:
        bits = []
        types = self.ed.types_of(s)
        if len(types) < len(ALL_TYPES):
            bits.append("/".join(types))
        for k in ("format", "pattern", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum",
                  "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "minProperties", "maxProperties"):
            if k in s:
                bits.append(f"{k} {_compact(s[k], 30)}")
        if s.get("uniqueItems") is True:
            bits.append("uniqueItems")
        if isinstance(s.get("required"), list) and s["required"]:
            bits.append("required " + ", ".join(map(str, s["required"])))
        if "default" in s:
            bits.append(f"default {_compact(s['default'], 30)}")
        return " · ".join(bits)

    def _errors_text(self, path: tuple) -> Text:
        ptr = to_ptr(path)
        here = [e for e in self.ed.validate() if e["path"] == ptr]
        below = sum(1 for e in self.ed.validate() if e["path"] != ptr and e["path"].startswith(ptr + "/"))
        t = Text()
        for e in here:
            t.append("✗ " + e["message"] + "\n", style="red")
        if below:
            t.append(f"{below} more error{'s' if below != 1 else ''} inside\n", style="dim red")
        t.rstrip()
        return t

    def _update_errors_widget(self) -> None:
        for w in self.query("#d-errors"):
            w.update(self._errors_text(self.current.path))        # type: ignore[attr-defined]

    def detail_widgets(self):
        ed, ref = self.ed, self.current
        path = ref.path
        parent_path = path[:-1]
        if ref.ghost:
            yield Static(Text(to_ptr(path), style="dim"))
            yield Static(Text(f'"{path[-1]}" is required here but is missing.'))
            yield Horizontal(Button("Add it", id="btn-addghost", variant="success"), classes="buttons")
            return
        value, s, chain = ed.info(path)
        if value is _MISSING:
            yield Static(Text("(nothing here)"))
            return
        yield Static(Text(to_ptr(path) or "(whole document)", style="dim"))
        if s.get("title"):
            yield Static(Text(str(s["title"]), style="bold"))
        if s.get("description"):
            yield Static(Text(str(s["description"])))
        hint = self._constraints(s)
        if hint:
            yield Static(Text(hint, style="italic dim"))

        for level, (lst, idx) in enumerate(chain):
            yield Label(Text("Alternative" if level == 0 else f"Alternative (level {level + 1})", style="bold"))
            yield Select([(Text(v["label"]), i) for i, v in enumerate(lst)], value=idx, allow_blank=False,
                         id=f"d-variant-{level}")

        yield from self._editor_widgets(value, s)
        yield Static(Text(""), id="d-draft")
        yield Static(self._errors_text(path), id="d-errors")

        buttons: list[Button] = []
        if isinstance(value, (dict, list)):
            buttons.append(Button("Add…" if isinstance(value, dict) else "Add item", id="btn-add", variant="success"))
        if path:
            pv = get_at(self.ed.document, parent_path)
            buttons.append(Button("Delete", id="btn-remove", variant="error"))
            if isinstance(pv, list):
                buttons.append(Button("↑", id="btn-up"))
                buttons.append(Button("↓", id="btn-down"))
            elif isinstance(pv, dict):
                _, ps, _ = ed.info(parent_path)
                if not (isinstance(ps.get("properties"), dict) and str(path[-1]) in ps["properties"]):
                    buttons.append(Button("Rename", id="btn-rename"))
        if buttons:
            yield Horizontal(*buttons, classes="buttons")

    def _editor_widgets(self, value: Any, s: dict):
        if "const" in s:
            yield Static(Text("Fixed value: " + _dumps(s["const"])))
            return
        if isinstance(s.get("enum"), list):
            cur = next((i for i, e in enumerate(s["enum"]) if deep_equal(e, value)), None)
            opts = [(Text(e if isinstance(e, str) else _dumps(e)), i) for i, e in enumerate(s["enum"])]
            if cur is None:
                yield Select(opts, allow_blank=True, prompt="(current value is not allowed)", id="d-enum")
            else:
                yield Select(opts, value=cur, allow_blank=False, id="d-enum")
            return
        t = self.ed.types_of(s)[0]
        if not is_type(value, t):
            yield Static(Text(f"The value is {type_of(value)}, but the schema expects {t}.", style="red"))
            yield Button(f"Replace with a valid {t}", id="btn-replace", variant="warning")
            return
        if t == "string":
            if s.get("format") == "textarea" or (isinstance(s.get("maxLength"), int) and s["maxLength"] > 200) \
                    or "\n" in value:
                yield TextArea(value, id="d-text")
            else:
                yield Input(value, id="d-input", password=s.get("format") == "password")
        elif t in ("number", "integer"):
            yield Input(_num(value), id="d-input", restrict=r"[0-9eE.+\-]*")
        elif t == "boolean":
            yield Switch(value, id="d-switch")
        elif t == "null":
            yield Static(Text("null", style="dim"))
        elif t == "object":
            yield Static(Text(f"{len(value)} propert{'y' if len(value) == 1 else 'ies'}. "
                              "Select one in the tree to edit it, or add another below."))
        elif t == "array":
            yield Static(Text(f"{len(value)} item{'' if len(value) == 1 else 's'}."))

    # ---- editing through the panel ---------------------------------------------------------

    def _draft(self, msg: str) -> None:
        for w in self.query("#d-draft"):
            w.update(Text(msg, style="red"))                       # type: ignore[attr-defined]

    def _toast(self, msg: str, severity: str = "error") -> None:
        self.notify(msg, severity=severity, timeout=5, markup=False)  # type: ignore[arg-type]

    @staticmethod
    def _parse_number(text: str) -> Any:
        text = text.strip()
        if re.fullmatch(r"[+-]?\d+", text):
            return int(text)
        if re.fullmatch(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", text):
            return float(text)
        return _MISSING

    def _text_edit(self, text: str) -> None:
        path = self.current.path
        value, s, _ = self.ed.info(path)
        t = self.ed.types_of(s)[0] if value is not _MISSING else "string"
        if t == "string":
            new: Any = text
        else:
            new = self._parse_number(text)
            if new is _MISSING:
                self._draft("Enter a valid number")
                return
        if value is not _MISSING and deep_equal(new, value):
            self._draft("")
            return
        r = self.ed.ui_set(path, new, coalesce=("text", to_ptr(path)))
        if r.ok:
            self._draft("")
            self._after_change(path)
        else:
            self._draft(r.message(to_ptr(path)))

    @on(Input.Changed, "#d-input")
    def _input_changed(self, event: Input.Changed) -> None:
        self._text_edit(event.value)

    @on(TextArea.Changed, "#d-text")
    def _textarea_changed(self, event: TextArea.Changed) -> None:
        self._text_edit(event.text_area.text)

    @on(Input.Submitted, "#d-input")
    def _input_done(self) -> None:
        self.action_focus_tree()

    @on(Switch.Changed, "#d-switch")
    def _switch_changed(self, event: Switch.Changed) -> None:
        path = self.current.path
        if deep_equal(get_at(self.ed.document, path), event.value):
            return
        r = self.ed.ui_set(path, event.value)
        if r.ok:
            self._after_change(path)
        else:
            self._toast(r.message(to_ptr(path)))
            event.switch.value = not event.value

    @on(Select.Changed)
    def _select_changed(self, event: Select.Changed) -> None:
        sid = event.select.id or ""
        if event.value is Select.NULL:
            return
        path = self.current.path
        if sid == "d-enum":
            _, s, _ = self.ed.info(path)
            new = s["enum"][event.value]
            if deep_equal(new, get_at(self.ed.document, path)):
                return
            r = self.ed.ui_set(path, clone(new))
            if r.ok:
                self._after_change(path)
            else:
                self._toast(r.message(to_ptr(path)))
                self._show_detail()
        elif sid.startswith("d-variant-"):
            level = int(sid.rsplit("-", 1)[1])
            _, _, chain = self.ed.info(path)
            if level < len(chain) and chain[level][1] == event.value:
                return
            r = self.ed.ui_switch(path, level, event.value)
            if r.ok:
                self._after_change(path, recompose=True)
            else:
                self._toast(r.message(to_ptr(path)))
                self._show_detail()

    @on(Button.Pressed)
    def _button(self, event: Button.Pressed) -> None:
        bid = event.button.id
        path = self.current.path
        if bid == "btn-add":
            self.action_add()
        elif bid == "btn-addghost":
            self._add_property(path[:-1], str(path[-1]))
        elif bid == "btn-remove":
            self.action_remove()
        elif bid == "btn-up":
            self.action_move_up()
        elif bid == "btn-down":
            self.action_move_down()
        elif bid == "btn-rename":
            self.action_rename()
        elif bid == "btn-replace":
            r = self.ed.ui_replace_with_default(path)
            if r.ok:
                self._after_change(path, recompose=True)
            else:
                self._toast(r.message(to_ptr(path)))

    # ---- actions -------------------------------------------------------------------------------

    def action_focus_tree(self) -> None:
        self.ed.break_undo()
        self.tree.focus()

    def action_edit(self) -> None:
        ref = self.current
        if ref.ghost:
            self._add_property(ref.path[:-1], str(ref.path[-1]))
            return
        value = get_at(self.ed.document, ref.path)
        if isinstance(value, bool) and not self.query("#d-enum"):
            r = self.ed.ui_set(ref.path, not value)
            if r.ok:
                self._after_change(ref.path)
                self._show_detail()
            else:
                self._toast(r.message(to_ptr(ref.path)))
            return
        self._focus_editor()

    def _focus_editor(self) -> bool:
        for w in self.query("#d-input, #d-text, #d-enum, #d-switch, #d-variant-0"):
            w.focus()
            return True
        return False

    def _add_property(self, path, key: str) -> None:
        path = tuple(path)
        r = self.ed.ui_add_property(path, key)
        if r.ok:
            self._after_change(path)
            self._select_path(path + (key,))
        else:
            self._toast(r.message(to_ptr(path)))

    def action_add(self) -> None:
        ref = self.current
        if ref.ghost:
            return self._add_property(ref.path[:-1], str(ref.path[-1]))
        path = ref.path
        value = get_at(self.ed.document, path)
        if not isinstance(value, (dict, list)):
            path = path[:-1]
            value = get_at(self.ed.document, path)
        if isinstance(value, list):
            r = self.ed.ui_add_item(path)
            if r.ok:
                self._after_change(path)
                self._select_path(path + (len(value),))
            else:
                self._toast(r.message(to_ptr(path)))
            return
        if not isinstance(value, dict):
            return
        props, free = self.ed.addable_properties(path)
        if not props and not free:
            self._toast("No more properties can be added here.", "warning")
            return

        def ask_name() -> None:
            def got(name: Optional[str]) -> None:
                if name is not None:
                    self._add_property(path, name)
            self.push_screen(PromptScreen("New property name", placeholder="name"), got)

        if not props:
            return ask_name()
        options = [(p["title"] + ("  (required)" if p["required"] else ""), p["description"]) for p in props]
        if free:
            options.append(("+ A property with another name…", ""))

        def picked(i: Optional[int]) -> None:
            if i is None:
                return
            if i < len(props):
                self._add_property(path, props[i]["key"])
            else:
                ask_name()

        self.push_screen(PickScreen("Add a property", options), picked)

    def action_remove(self) -> None:
        ref = self.current
        if not ref.path:
            return self._toast("The whole document can't be deleted.", "warning")
        if ref.ghost:
            return self._toast("That property doesn't exist yet.", "warning")
        path, parent = ref.path, ref.path[:-1]
        pv = get_at(self.ed.document, parent)
        r = self.ed.ui_remove(path)
        if not r.ok:
            return self._toast(r.message(to_ptr(parent)))
        self._after_change(parent)
        target: tuple = parent
        if isinstance(pv, list):
            left = len(get_at(self.ed.document, parent))
            if left:
                target = parent + (min(int(path[-1]), left - 1),)
        self._select_path(target)

    def _move(self, delta: int) -> None:
        path = self.current.path
        if not path or not isinstance(get_at(self.ed.document, path[:-1]), list):
            return self._toast("Only array items can be moved.", "warning")
        r = self.ed.ui_move(path, delta)
        if not r.ok:
            return self._toast(r.message(to_ptr(path[:-1])))
        self._after_change(path[:-1])
        self._select_path(path[:-1] + (int(path[-1]) + delta,))

    def action_move_up(self) -> None:
        self._move(-1)

    def action_move_down(self) -> None:
        self._move(1)

    def action_rename(self) -> None:
        path = self.current.path
        if not path or not isinstance(get_at(self.ed.document, path[:-1]), dict) or self.current.ghost:
            return self._toast("Only properties of objects can be renamed.", "warning")

        def got(name: Optional[str]) -> None:
            if name is None or name == str(path[-1]):
                return
            r = self.ed.ui_rename(path, name)
            if r.ok:
                self._after_change(path[:-1])
                self._select_path(path[:-1] + (name,))
            else:
                self._toast(r.message(to_ptr(path[:-1])))

        self.push_screen(PromptScreen("Rename property", str(path[-1])), got)

    def _reload(self) -> None:
        keep = self.current.path
        self._rebuild_tree()
        self._select_path(keep)

    def action_undo(self) -> None:
        if self.ed.undo():
            self._reload()
        else:
            self._toast("Nothing to undo.", "warning")

    def action_redo(self) -> None:
        if self.ed.redo():
            self._reload()
        else:
            self._toast("Nothing to redo.", "warning")

    def action_help(self) -> None:
        self.push_screen(HelpScreen())

    def _finish(self) -> None:
        if self.save_handler is None:
            self.exit(("ok", self.ed.get_document()))
            return
        try:
            message = self.save_handler(self.ed.get_document())
        except OSError as exc:
            self._toast(f"Could not save: {exc}")
            return
        self.ed.mark_saved()
        self._update_status()
        self._toast(message or "Saved.", "information")

    def action_save(self) -> None:
        n = len(self.ed.validate())
        if n:
            def answer(choice: str) -> None:
                if choice == "yes":
                    self._finish()
            self.push_screen(ConfirmScreen(
                f"The document still has {n} error{'s' if n != 1 else ''}. "
                f"{'Save' if self.save_handler else 'Finish'} anyway?",
                [("Yes", "yes", "warning"), ("Keep editing", "no", "default")]), answer)
        else:
            self._finish()

    def action_quit_app(self) -> None:
        def leave_unsaved() -> None:
            self.exit(None)

        if self.save_handler is not None and not self.ed.modified:
            self.exit(("ok", self.ed.get_document()))
        elif not self.ed.modified:
            leave_unsaved()
        else:
            def answer(choice: str) -> None:
                if choice == "save":
                    if self.save_handler is None:
                        self._finish()
                    else:
                        try:
                            self.save_handler(self.ed.get_document())
                        except OSError as exc:
                            self._toast(f"Could not save: {exc}")
                            return
                        self.ed.mark_saved()
                        self.exit(("ok", self.ed.get_document()))
                elif choice == "discard":
                    leave_unsaved()
            self.push_screen(ConfirmScreen(
                "You have unsaved changes.",
                [("Save" if self.save_handler else "Finish", "save", "success"),
                 ("Discard", "discard", "error"), ("Cancel", "cancel", "default")]), answer)
