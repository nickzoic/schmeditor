"""The document model and its programmatic API."""
import pytest

from schmeditor import ChangeRejected, SchemaEditor


def test_edits_are_applied_and_checked(contact_schema, contact_doc):
    ed = SchemaEditor(contact_schema, contact_doc)
    assert ed.is_valid()
    ed.set("/name", "Grace")
    ed.push("/tags", "x")
    ed.insert("/tags", 0, "first")
    assert ed.get("/tags") == ["first", "math", "engines", "x"]
    ed.remove("/address")
    assert ed.get("/address") is None and ed.is_valid()
    ed.set("", {**ed.get_document(), "nickname": "Ace"})
    assert ed.get("/nickname") == "Ace"


def test_rejected_edits_leave_the_document_alone(contact_schema, contact_doc):
    ed = SchemaEditor(contact_schema, contact_doc)
    before = ed.get_document()
    with pytest.raises(ChangeRejected) as info:
        ed.set("/numbers/quantity", 999)
    assert "at most 99" in str(info.value) and info.value.errors
    for bad in (lambda: ed.remove("/name"), lambda: ed.push("/name", "x"),
                lambda: ed.set("/nope/deeper", 1), lambda: ed.insert("/tags", 99, "x"),
                lambda: ed.set("/composition/pet", {"good": True, "fins": 2})):
        with pytest.raises((ChangeRejected, ValueError)):
            bad()
    assert ed.get_document() == before


def test_paths_can_be_pointers_or_key_lists(contact_schema, contact_doc):
    ed = SchemaEditor(contact_schema, contact_doc)
    assert ed.get("/tags/0") == ed.get(["tags", 0]) == "math"
    with pytest.raises(ValueError):
        ed.get("tags")


def test_get_and_get_document_return_copies(contact_schema, contact_doc):
    ed = SchemaEditor(contact_schema, contact_doc)
    ed.get("/tags").append("zzz")
    ed.get_document()["tags"].append("zzz")
    assert "zzz" not in ed.get("/tags")
    contact_doc["name"] = "mutated"          # and the caller's input is not shared either
    assert ed.get("/name") == "Ada"


def test_on_change_hears_user_edits_and_api_edits_only_when_asked(contact_schema, contact_doc):
    calls = []
    ed = SchemaEditor(contact_schema, contact_doc, on_change=lambda d, i: calls.append(i))
    ed.set("/name", "Zed")
    assert calls == []
    assert ed.ui_set(["username"], "grace").ok
    assert calls == [{"path": "/username", "source": "user"}]
    noisy = SchemaEditor(contact_schema, contact_doc, notify_on_programmatic=True,
                         on_change=lambda d, i: calls.append(i))
    noisy.set("/name", "Zed")
    assert calls[-1] == {"path": "/name", "source": "api"}


def test_a_failing_callback_does_not_break_editing(contact_schema, contact_doc, caplog):
    def boom(doc, info):
        raise RuntimeError("callback bug")
    ed = SchemaEditor(contact_schema, contact_doc, on_change=boom)
    assert ed.ui_set(["name"], "Zed").ok
    assert ed.get("/name") == "Zed"


def test_invalid_documents_may_only_get_better(contact_schema):
    ed = SchemaEditor(contact_schema, {"tags": ["a"], "numbers": {"quantity": 500}})
    assert len(ed.validate()) == 2
    ed.set("/name", "Zed")                         # fixes "required"
    assert len(ed.validate()) == 1
    with pytest.raises(ChangeRejected):
        ed.set("/numbers/quantity", "text")        # a new kind of error


def test_undo_and_redo(contact_schema, contact_doc):
    ed = SchemaEditor(contact_schema, contact_doc)
    assert not ed.undo()
    assert ed.ui_set(["name"], "A1").ok and ed.ui_set(["username"], "bob").ok
    assert ed.undo() and ed.get("/username") == "ada"
    assert ed.undo() and ed.get("/name") == "Ada"
    assert ed.redo() and ed.get("/name") == "A1"


def test_runs_of_keystrokes_undo_as_one_step(contact_schema, contact_doc):
    ed = SchemaEditor(contact_schema, contact_doc)
    for text in ("Gr", "Gra", "Grac", "Grace"):
        assert ed.ui_set(["name"], text, coalesce=("text", "/name")).ok
    assert ed.undo() and ed.get("/name") == "Ada"


def test_json_null_is_a_valid_document():
    ed = SchemaEditor({"type": "null"}, None)
    assert ed.get_document() is None and ed.is_valid()


def test_conditional_requirements_are_filled_in_by_interactive_edits(contact_schema, contact_doc):
    ed = SchemaEditor(contact_schema, contact_doc)
    assert ed.ui_set(["role"], "staff").ok
    assert ed.get("/department") == "Operations"
    ed2 = SchemaEditor(contact_schema, contact_doc)
    with pytest.raises(ChangeRejected):            # the API never changes more than you asked for
        ed2.set("/role", "staff")


def test_interactive_operations(contact_schema, contact_doc):
    ed = SchemaEditor(contact_schema, contact_doc)
    assert ed.ui_add_item(["tags"]).ok and ed.get("/tags") == ["math", "engines", "x"]
    assert ed.ui_move(["tags", 2], -1).ok and ed.get("/tags") == ["math", "x", "engines"]
    assert ed.ui_remove(["tags", 1]).ok
    assert not ed.ui_remove(["name"]).ok
    assert ed.ui_rename(["objects", "labels", "team"], "crew").ok
    assert list(ed.get("/objects/labels")) == ["crew"]
    props, free = ed.addable_properties(["billing"])
    assert {"gift", "phone"} <= {p["key"] for p in props} and free
    assert ed.ui_add_property(["billing"], "gift").ok
    assert ed.get("/billing/giftMessage") == "Happy birthday!"      # dependentSchemas: filled in
    assert not ed.ui_add_property(["billing"], "gift").ok            # already there
    assert not ed.ui_add_property(["objects", "limits"], "foo").ok   # additionalProperties: false
    assert ed.is_valid()
