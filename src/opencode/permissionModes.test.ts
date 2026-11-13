import assert from "node:assert/strict";
import test from "node:test";
import {
    PERMISSION_MODE_RULES,
    applyPermissionMode,
    identifyPermissionMode,
    isFingerprintRule,
    manualRuleCount,
    permissionActionLabelKey,
    sortSavedPermissions,
} from "./permissionModes.ts";
import type {PermissionRule, SavedPermission} from "./types.ts";

const strict = PERMISSION_MODE_RULES.strict;
const balanced = PERMISSION_MODE_RULES.balanced;
const full = PERMISSION_MODE_RULES.full;
const manual: PermissionRule = {action: "shell", resource: "git push *", effect: "deny"};

test("identify: absent or empty permissions read as the virtual strict fallback", () => {
    assert.equal(identifyPermissionMode(undefined), "strict");
    assert.equal(identifyPermissionMode(null), "strict");
    assert.equal(identifyPermissionMode([]), "strict");
});

test("identify: exact fingerprints", () => {
    assert.equal(identifyPermissionMode([...strict]), "strict");
    assert.equal(identifyPermissionMode([...balanced]), "balanced");
    assert.equal(identifyPermissionMode([...full]), "full");
});

test("identify: largest match wins — strict superset is not misread as balanced", () => {
    // strict's fingerprint contains both of balanced's rules; strict must win.
    assert.equal(identifyPermissionMode([...strict, manual]), "strict");
});

test("identify: fingerprint present among manual rules still counts", () => {
    assert.equal(identifyPermissionMode([manual, ...balanced]), "balanced");
    assert.equal(identifyPermissionMode([manual, ...full]), "full");
});

test("identify: partial fingerprints are NOT a mode (falls back to strict)", () => {
    assert.equal(identifyPermissionMode([balanced[0]]), "strict");
    assert.equal(identifyPermissionMode(full.slice(0, 2)), "strict");
});

test("identify: manual look-alikes complete a fingerprint (documented edge)", () => {
    // A hand-written `shell * → ask` plus balanced's other rule reads as
    // balanced — semantically identical, and the rewrite below keeps the
    // end state correct.
    const lookAlike: PermissionRule = {action: "shell", resource: "*", effect: "ask"};
    assert.equal(identifyPermissionMode([balanced[0], lookAlike]), "balanced");
});

test("manualRuleCount: counts only non-fingerprint rules", () => {
    assert.equal(manualRuleCount(undefined), 0);
    assert.equal(manualRuleCount([...strict]), 0);
    assert.equal(manualRuleCount([...strict, manual, manual]), 2);
});

test("isFingerprintRule membership", () => {
    assert.ok(isFingerprintRule({action: "shell", resource: "*", effect: "ask"}));
    assert.ok(!isFingerprintRule(manual));
    assert.ok(!isFingerprintRule({action: "edit", resource: "*", effect: "allow"}));
});

test("apply: appends the target fingerprint when nothing existed", () => {
    assert.deepEqual(applyPermissionMode(undefined, "balanced"), [...balanced]);
    assert.deepEqual(applyPermissionMode([], "strict"), [...strict]);
});

test("apply: switching modes strips the old fingerprint, keeps manual rules, appends new", () => {
    const from = [manual, ...balanced];
    const to = applyPermissionMode(from, "full");
    // manual survives, old balanced members gone, full appended at the end.
    assert.deepEqual(to, [manual, ...full]);
    const back = applyPermissionMode(to, "balanced");
    assert.deepEqual(back, [manual, ...balanced]);
});

test("apply: switching TO strict writes real rules (no-rules is permissive)", () => {
    const to = applyPermissionMode([manual], "strict");
    assert.deepEqual(to, [manual, ...strict]);
});

test("apply: manual look-alike rules are normalized away by the rewrite", () => {
    const lookAlike: PermissionRule = {action: "shell", resource: "*", effect: "ask"};
    const to = applyPermissionMode([lookAlike, manual], "full");
    assert.deepEqual(to, [manual, ...full]);
});

test("sortSavedPermissions: newest first, input untouched", () => {
    const mk = (id: string, created: number): SavedPermission => ({
        id, projectID: "p", action: "read", resource: "*.env",
        time: {created, updated: created},
    });
    const a = mk("a", 100), b = mk("b", 300), c = mk("c", 200);
    const list = [a, b, c];
    assert.deepEqual(sortSavedPermissions(list).map((s) => s.id), ["b", "c", "a"]);
    assert.deepEqual(list.map((s) => s.id), ["a", "b", "c"]);
});

test("permissionActionLabelKey: known actions map, unknown falls to null", () => {
    assert.equal(permissionActionLabelKey("shell"), "Run a shell command");
    assert.equal(permissionActionLabelKey("bash"), "Run a shell command");
    assert.equal(permissionActionLabelKey("external_directory"), "Access a folder outside the project");
    assert.equal(permissionActionLabelKey("edit"), "Edit a file");
    assert.equal(permissionActionLabelKey("read"), "Read files");
    assert.equal(permissionActionLabelKey("glob"), "Search for files");
    assert.equal(permissionActionLabelKey("grep"), "Search file contents");
    assert.equal(permissionActionLabelKey("mcp_something_fetch"), null);
});
