"""The terminal UI, driven with keystrokes through Textual's test pilot."""
import asyncio
import copy

from textual.widgets import Select, Tree

from schmeditor import SchemaEditor
from schmeditor.tui import EditorApp


def ui_test(fn):
    """Run an async test body as a plain test: `async def body(app, ed, press, settle)`."""
    def wrapper(contact_schema, contact_doc, metaschema):
        asyncio.run(fn(contact_schema, copy.deepcopy(contact_doc), metaschema))
    wrapper.__name__ = fn.__name__          # not functools.wraps: pytest must see *this* signature
    wrapper.__doc__ = fn.__doc__
    return wrapper


async def start(schema, doc, **kwargs):
    ed = SchemaEditor(schema, doc)
    return ed, EditorApp(ed, **kwargs)


def text_of(widget):
    content = getattr(widget, "content", None)
    return str(content) if content is not None else str(widget.renderable)


async def settle(pilot):
    await pilot.pause()
    await pilot.pause()


@ui_test
async def test_typing_into_a_field_commits_live_and_refuses_bad_values(schema, doc, _meta):
    ed, app = await start(schema, doc)
    async with app.run_test(size=(130, 45)) as pilot:
        await settle(pilot)
        await pilot.press("down")
        await settle(pilot)
        assert app.current.path == ("name",)
        await pilot.press("enter")
        await settle(pilot)
        assert app.focused.id == "d-input"
        await pilot.press("A")                      # replaces the selected text; one letter is too short
        await settle(pilot)
        assert ed.get("/name") == "Ada"
        assert "at least 2" in text_of(app.query_one("#d-draft"))
        await pilot.press("l")
        await settle(pilot)
        assert ed.get("/name") == "Al"
        assert '"Al"' in str(app._find_node(("name",)).label)
        await pilot.press("escape")
        await settle(pilot)
        assert isinstance(app.focused, Tree)


@ui_test
async def test_numbers_respect_limits_and_booleans_toggle(schema, doc, _meta):
    ed, app = await start(schema, doc)
    async with app.run_test(size=(130, 45)) as pilot:
        app._select_path(("numbers", "quantity"))
        await settle(pilot)
        await pilot.press("enter")
        await pilot.press("9", "9", "9")            # 9 and 99 are fine; 999 is over the maximum of 99
        await settle(pilot)
        assert ed.get("/numbers/quantity") == 99
        assert "at most 99" in text_of(app.query_one("#d-draft"))
        await pilot.press("escape")
        app._select_path(("arrays", "legacy", 2))
        await settle(pilot)
        await pilot.press("e")
        await settle(pilot)
        assert ed.get("/arrays/legacy/2") is False


@ui_test
async def test_choosing_an_enum_value_fills_in_conditionally_required_properties(schema, doc, _meta):
    ed, app = await start(schema, doc)
    async with app.run_test(size=(130, 45)) as pilot:
        app._select_path(("role",))
        await settle(pilot)
        app.query_one("#d-enum", Select).value = 2
        await settle(pilot)
        assert ed.get("/role") == "staff"
        assert ed.get("/department") == "Operations"
        assert app._find_node(("department",)).data.path == ("department",)


@ui_test
async def test_add_with_the_picker_then_arrays_move_delete_undo(schema, doc, _meta):
    ed, app = await start(schema, doc)
    async with app.run_test(size=(130, 45)) as pilot:
        app._select_path(("billing",))
        await settle(pilot)
        await pilot.press("a")
        await settle(pilot)
        assert type(app.screen).__name__ == "PickScreen"
        await pilot.press(*"gift")
        await settle(pilot)
        await pilot.press("enter")
        await settle(pilot)
        assert ed.get("/billing/gift") is False
        assert ed.get("/billing/giftMessage") == "Happy birthday!"
        assert isinstance(app.focused, Tree)

        app._select_path(("tags",))
        await settle(pilot)
        await pilot.press("a")
        await settle(pilot)
        assert ed.get("/tags") == ["math", "engines", "x"] and app.current.path == ("tags", 2)
        await pilot.press("K")
        await settle(pilot)
        assert ed.get("/tags") == ["math", "x", "engines"]
        await pilot.press("d")
        await settle(pilot)
        assert ed.get("/tags") == ["math", "engines"]
        await pilot.press("ctrl+z")
        await settle(pilot)
        assert ed.get("/tags") == ["math", "x", "engines"]
        await pilot.press("ctrl+y")
        await settle(pilot)
        assert ed.get("/tags") == ["math", "engines"]


@ui_test
async def test_refused_edits_do_not_change_the_document(schema, doc, _meta):
    ed, app = await start(schema, doc)
    async with app.run_test(size=(130, 45)) as pilot:
        app._select_path(("name",))
        await settle(pilot)
        before = ed.get_document()
        await pilot.press("d")                      # "name" is required
        await settle(pilot)
        assert ed.get_document() == before


@ui_test
async def test_switching_alternatives_and_renaming(schema, doc, _meta):
    ed, app = await start(schema, doc)
    async with app.run_test(size=(130, 45)) as pilot:
        app._select_path(("composition", "pet"))
        await settle(pilot)
        app.query_one("#d-variant-0", Select).value = 1
        await settle(pilot)
        assert ed.get("/composition/pet") == {"fins": 1}

        app._select_path(("objects", "labels", "team"))
        await settle(pilot)
        await pilot.press("r")
        await settle(pilot)
        assert type(app.screen).__name__ == "PromptScreen"
        await pilot.press("c", "r", "e", "w", "enter")   # the old name is pre-selected, so typing replaces it
        await settle(pilot)
        assert list(ed.get("/objects/labels")) == ["crew"]
        assert ed.is_valid()


@ui_test
async def test_missing_required_properties_show_as_placeholders(schema, doc, _meta):
    ed, app = await start(schema, {"tags": ["a"]})
    async with app.run_test(size=(130, 45)) as pilot:
        await settle(pilot)
        ghosts = [n.data.path for n in app._walk(app.tree.root) if n.data.ghost]
        assert ghosts == [("name",)]
        app._select_path(("name",))
        await settle(pilot)
        await pilot.press("enter")
        await settle(pilot)
        assert ed.get("/name") == "Unnamed" and ed.is_valid()


@ui_test
async def test_a_wrongly_typed_value_can_be_replaced(schema, doc, _meta):
    ed, app = await start(schema, {"name": 5, "tags": ["a"]})
    async with app.run_test(size=(130, 45)) as pilot:
        app._select_path(("name",))
        await settle(pilot)
        await pilot.click("#btn-replace")
        await settle(pilot)
        assert ed.get("/name") == "Unnamed" and ed.is_valid()


@ui_test
async def test_every_node_of_the_example_has_a_detail_panel(schema, doc, _meta):
    ed, app = await start(schema, doc)
    async with app.run_test(size=(130, 45)) as pilot:
        await settle(pilot)
        nodes = list(app._walk(app.tree.root))
        assert len(nodes) > 50
        for node in nodes:
            app._select_path(node.data.path)
            await settle(pilot)
            assert len(app.query("#detail > *")) > 0


@ui_test
async def test_editing_a_schema_with_the_metaschema(schema, doc, metaschema):
    task = {"type": "object", "required": ["title"], "properties": {"title": {"type": "string", "minLength": 1}}}
    ed, app = await start(metaschema, task)
    async with app.run_test(size=(130, 45)) as pilot:
        await settle(pilot)
        assert ed.is_valid()
        await pilot.press("a")                      # many keywords are available: a filterable picker
        await settle(pilot)
        assert app.screen.query_one("#pick-list").option_count > 15
        await pilot.press(*"description")
        await pilot.press("enter")
        await settle(pilot)
        assert ed.get("/description") == ""
        assert not ed.ui_add_property((), "minLength").ok       # a string keyword on an object schema

        app._select_path(("properties",))
        await settle(pilot)
        await pilot.press("a")                      # free-form keys: straight to a name prompt
        await settle(pilot)
        assert type(app.screen).__name__ == "PromptScreen"
        await pilot.press(*"age", "enter")
        await settle(pilot)
        assert ed.get("/properties/age") == {"type": "string"}
        app._select_path(("properties", "age"))
        await settle(pilot)
        labels = [v["label"] for v in ed.info(("properties", "age"))[2][0][0]]
        app.query_one("#d-variant-0", Select).value = labels.index("Integer")
        await settle(pilot)
        assert ed.get("/properties/age") == {"type": "integer"}
        app.query_one("#d-variant-0", Select).value = labels.index("Number")
        await settle(pilot)
        assert ed.get("/properties/age") == {"type": "number"}   # remembered, not flipped back to Integer
        assert ed.is_valid()


@ui_test
async def test_finishing_and_quitting_as_a_library(schema, doc, _meta):
    ed, app = await start(schema, doc)
    async with app.run_test(size=(130, 45)) as pilot:
        await settle(pilot)
        await pilot.press("ctrl+s")
        await settle(pilot)
    assert app.return_value == ("ok", ed.get_document())

    ed, app = await start(schema, doc)
    async with app.run_test(size=(130, 45)) as pilot:
        await settle(pilot)
        await pilot.press("ctrl+q")
        await settle(pilot)
    assert app.return_value is None

    ed, app = await start(schema, doc)
    async with app.run_test(size=(130, 45)) as pilot:
        app._select_path(("name",))
        await settle(pilot)
        await pilot.press("enter", "Z", "Z", "escape", "ctrl+q")
        await settle(pilot)
        assert type(app.screen).__name__ == "ConfirmScreen"      # unsaved changes: ask first
        await pilot.click("#discard")
        await settle(pilot)
    assert app.return_value is None


@ui_test
async def test_finishing_an_invalid_document_asks_first(schema, doc, _meta):
    ed, app = await start(schema, {"tags": ["a"]})
    async with app.run_test(size=(130, 45)) as pilot:
        await settle(pilot)
        await pilot.press("ctrl+s")
        await settle(pilot)
        assert type(app.screen).__name__ == "ConfirmScreen"
        await pilot.click("#yes")
        await settle(pilot)
    assert app.return_value == ("ok", {"tags": ["a"]})


@ui_test
async def test_save_handler_saves_and_keeps_editing(schema, doc, _meta):
    saved = []
    ed, app = await start(schema, doc, save_handler=lambda d: (saved.append(d), "Saved!")[1])
    async with app.run_test(size=(130, 45)) as pilot:
        app._select_path(("name",))
        await settle(pilot)
        await pilot.press("enter", "Q", "u", "escape", "ctrl+s")
        await settle(pilot)
        assert len(saved) == 1 and saved[0]["name"] == "Qu" and app.is_running
        assert not ed.modified
        await pilot.press("ctrl+q")
        await settle(pilot)
    assert app.return_value[0] == "ok"
