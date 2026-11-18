"""The document model and its programmatic API."""
import copy

import pytest

from schmeditor import ChangeRejected, SchemaEditor, apply_patch
from schmeditor.engine import deep_equal


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
    assert calls == [{"source": "user", "path": "/username", "value": "grace",
                      "patch": [{"op": "replace", "path": "/username", "value": "grace"}]}]
    noisy = SchemaEditor(contact_schema, contact_doc, notify_on_programmatic=True,
                         on_change=lambda d, i: calls.append(i))
    noisy.set("/name", "Zed")
    assert calls[-1] == {"source": "api", "path": "/name", "value": "Zed",
                         "patch": [{"op": "replace", "path": "/name", "value": "Zed"}]}


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


class Tracked:
    """An editor whose change callback checks every notification: the patch must turn the
    document as it was into the document it now is."""

    def __init__(self, schema, doc, **kwargs):
        self.before, self.events, self.problems = copy.deepcopy(doc), [], []
        kwargs.setdefault("notify_on_programmatic", True)
        self.ed = SchemaEditor(schema, doc, on_change=self._changed, **kwargs)

    def _changed(self, after, info):
        self.events.append(info)
        if not deep_equal(apply_patch(self.before, info["patch"]), after):
            self.problems.append((self.before, info["patch"], after))
        self.before = after

    @property
    def last(self):
        return self.events[-1]


def test_each_kind_of_edit_reports_the_operation_that_describes_it(contact_schema, contact_doc):
    t = Tracked(contact_schema, contact_doc)
    ed = t.ed

    assert ed.ui_set(["name"], "Alice").ok
    assert t.last["patch"] == [{"op": "replace", "path": "/name", "value": "Alice"}]

    assert ed.ui_add_item(["tags"]).ok                                      # add an array item
    assert t.last["patch"] == [{"op": "add", "path": "/tags/2", "value": "x"}]

    assert ed.ui_move(["tags", 0], 1).ok                                    # move an array item
    assert t.last["patch"] == [{"op": "move", "from": "/tags/0", "path": "/tags/1"}]
    assert t.last["path"] == "/tags" and t.last["value"] == ["engines", "math", "x"]

    assert ed.ui_remove(["tags", 0]).ok                                     # remove an array item
    assert t.last["patch"] == [{"op": "remove", "path": "/tags/0"}]
    assert "value" not in t.last                                            # not the item that shifted down
    assert ed.get("/tags") == ["math", "x"]

    assert ed.ui_remove(["address"]).ok                                     # remove a property
    assert t.last["patch"] == [{"op": "remove", "path": "/address"}]

    assert ed.ui_rename(["objects", "labels", "team"], "crew").ok           # rename a property
    assert t.last["patch"] == [{"op": "move", "from": "/objects/labels/team", "path": "/objects/labels/crew"}]
    assert t.last["path"] == "/objects/labels/crew"

    assert ed.ui_switch(["composition", "pet"], 0, 1).ok                    # switch alternative: whole value replaced
    assert t.last["patch"] == [{"op": "replace", "path": "/composition/pet", "value": {"fins": 1}}]

    assert ed.ui_add_property(["billing"], "phone").ok                      # dependencies: phoneType follows
    assert [o["path"] for o in t.last["patch"]] == ["/billing/phone", "/billing/phoneType"]
    assert t.problems == []


def test_properties_the_editor_fills_in_follow_the_main_operation(contact_schema, contact_doc):
    t = Tracked(contact_schema, contact_doc)
    assert t.ed.ui_set(["role"], "staff").ok                                # "staff" makes department required
    assert t.last["patch"] == [{"op": "replace", "path": "/role", "value": "staff"},
                               {"op": "add", "path": "/department", "value": "Operations"}]
    assert t.last["path"] == "/role" and t.last["value"] == "staff"
    assert t.problems == []


def test_programmatic_changes_report_json_patch_operations(contact_schema, contact_doc):
    t = Tracked(contact_schema, contact_doc)
    ed = t.ed
    ed.set("/numbers/quantity", 5)
    ed.remove("/address")
    ed.push("/tags", "x")
    ed.insert("/tags", 0, "first")
    ed.set("/arrays/milestones/2", 7)                                       # one past the end adds
    ed.set_document({"name": "Zed", "tags": ["t"]})
    assert [e["patch"] for e in t.events] == [
        [{"op": "replace", "path": "/numbers/quantity", "value": 5}],
        [{"op": "remove", "path": "/address"}],
        [{"op": "add", "path": "/tags/2", "value": "x"}],
        [{"op": "add", "path": "/tags/0", "value": "first"}],
        [{"op": "add", "path": "/arrays/milestones/2", "value": 7}],
        [{"op": "replace", "path": "", "value": {"name": "Zed", "tags": ["t"]}}],
    ]
    assert [(e["path"], e.get("value", "<removed>")) for e in t.events] == [
        ("/numbers/quantity", 5), ("/address", "<removed>"), ("/tags", ["math", "engines", "x"]),
        ("/tags", ["first", "math", "engines", "x"]), ("/arrays/milestones/2", 7),
        ("", {"name": "Zed", "tags": ["t"]}),
    ]
    assert t.problems == []


def test_undo_and_redo_report_a_diff(contact_schema, contact_doc):
    t = Tracked(contact_schema, contact_doc)
    assert t.ed.ui_remove(["address"]).ok
    assert t.ed.undo()
    assert t.last["patch"] == [{"op": "add", "path": "/address", "value": {"postcode": "3000"}}]
    assert t.ed.redo()
    assert t.last["patch"] == [{"op": "remove", "path": "/address"}]
    assert t.problems == []


def test_notifications_are_copies(contact_schema, contact_doc):
    received = []
    ed = SchemaEditor(contact_schema, contact_doc, on_change=lambda d, i: received.append((d, i)))
    assert ed.ui_add_item(["tags"]).ok
    doc, info = received[0]
    info["patch"][0]["value"] = "tampered"
    info["value"] = "tampered"
    doc["tags"].append("tampered")
    assert ed.get("/tags") == ["math", "engines", "x"]


def test_a_patch_is_never_wrong(contact_schema):
    ed = SchemaEditor({}, {})
    bad = [{"op": "remove", "path": "/nowhere"}]                  # can't be applied to the old document
    assert ed._make_patch({"a": 1}, {"a": 2}, bad) == [{"op": "replace", "path": "/a", "value": 2}]
    wrong = [{"op": "replace", "path": "/a", "value": 99}]        # applies, but gives the wrong document
    assert apply_patch({"a": 1}, ed._make_patch({"a": 1}, {"a": 2}, wrong)) == {"a": 2}
    move = [{"op": "move", "from": "/0", "path": "/1"}]           # right operation, wrong result
    assert apply_patch([1, 2, 3], ed._make_patch([1, 2, 3], [3, 1, 2], move)) == [3, 1, 2]


def test_patches_across_many_edits_and_for_the_metaschema(contact_schema, contact_doc, metaschema):
    t = Tracked(contact_schema, contact_doc)
    ed = t.ed
    ed.ui_set(["username"], "grace")
    ed.ui_set(["numbers", "quantity"], 7)
    ed.ui_add_item(["arrays", "milestones"])
    ed.ui_move(["arrays", "milestones", 0], 1)
    ed.ui_add_item(["arrays", "legacy"])
    ed.ui_set(["role"], "staff")
    ed.ui_set(["shipping", "method"], "delivery")                           # if/then/else adds a street
    ed.ui_switch(["composition", "reach"], 0, 2)                            # anyOf: email -> mailing address
    ed.ui_add_property(["billing"], "gift")                                 # dependentSchemas adds giftMessage
    ed.set("/nickname", "Ace")
    ed.insert("/composition/relatives", 0, {"name": "Zed"})
    assert len(t.events) >= 10 and t.problems == []

    m = Tracked(metaschema, {"type": "object", "properties": {"id": {"type": "string"}}})
    kinds = [v["label"] for v in m.ed.info(["properties", "id"])[2][0][0]]
    assert m.ed.ui_switch(["properties", "id"], 0, kinds.index("Several types")).ok
    assert m.ed.ui_add_item(["properties", "id", "type"]).ok
    assert m.ed.ui_add_property([], "required").ok
    m.ed.push("/required", "id")
    assert len(m.events) >= 4 and m.problems == []
