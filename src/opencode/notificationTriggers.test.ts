import test from "node:test";
import assert from "node:assert/strict";
import type {OpencodeSession} from "./types.ts";
import {
    attentionTitleKey,
    notifySubject,
    primaryAttentionKind,
    runEndTitleKey,
    shouldNotifyAttention,
    shouldNotifyRunEnd,
    type AttentionKind,
    type NotifyScene,
} from "./notificationTriggers.ts";

/** A scene with one field overridden — tests read as the case they name. */
function scene(overrides: Partial<NotifyScene> = {}): NotifyScene {
    return {mode: "full", muteFocusedCurrent: true, focused: false, activeId: "s1", ...overrides};
}

test("mode matrix: off never notifies, minimal only run ends, full both", () => {
    const off = scene({mode: "off"});
    assert.equal(shouldNotifyRunEnd(off, "s1", "succeeded"), false);
    assert.equal(shouldNotifyRunEnd(off, "s1", "failed"), false);
    assert.equal(shouldNotifyAttention(off, "s1"), false);

    const minimal = scene({mode: "minimal"});
    assert.equal(shouldNotifyRunEnd(minimal, "s1", "succeeded"), true);
    assert.equal(shouldNotifyRunEnd(minimal, "s1", "failed"), true);
    assert.equal(shouldNotifyAttention(minimal, "s1"), false);

    const full = scene({mode: "full"});
    assert.equal(shouldNotifyRunEnd(full, "s1", "succeeded"), true);
    assert.equal(shouldNotifyRunEnd(full, "s1", "failed"), true);
    assert.equal(shouldNotifyAttention(full, "s1"), true);
});

test("an unexpected reason string degrades to silence (interrupted never notifies)", () => {
    // The bus layer maps event types onto RunEndReason; a stray string
    // must not slip through as a ping.
    assert.equal(shouldNotifyRunEnd(scene(), "s1", "interrupted" as never), false);
});

test("focus mute suppresses only the focused window's OPEN session", () => {
    // Focused + the event's session is the open one → muted.
    assert.equal(shouldNotifyRunEnd(scene({focused: true}), "s1", "succeeded"), false);
    assert.equal(shouldNotifyAttention(scene({focused: true}), "s1"), false);
    // Focused, but the event belongs to a BACKGROUND session → still
    // notifies (parallel sessions are the feature's point).
    assert.equal(shouldNotifyRunEnd(scene({focused: true}), "s2", "succeeded"), true);
    assert.equal(shouldNotifyAttention(scene({focused: true}), "s2"), true);
    // Unfocused window → always notifies, even the open session.
    assert.equal(shouldNotifyRunEnd(scene({focused: false}), "s1", "succeeded"), true);
    // No open session (welcome screen) can never be muted.
    assert.equal(shouldNotifyAttention(scene({focused: true, activeId: null}), "s2"), true);
});

test("focus mute disabled suppresses nothing", () => {
    const neverMuted = scene({muteFocusedCurrent: false, focused: true});
    assert.equal(shouldNotifyRunEnd(neverMuted, "s1", "failed"), true);
    assert.equal(shouldNotifyAttention(neverMuted, "s1"), true);
});

test("primaryAttentionKind ranks work > plan > question > permission", () => {
    const kinds: AttentionKind[] = ["permission", "question", "plan", "work"];
    assert.equal(primaryAttentionKind(kinds), "work");
    assert.equal(primaryAttentionKind(["permission", "plan"]), "plan");
    assert.equal(primaryAttentionKind(["permission", "question"]), "question");
    assert.equal(primaryAttentionKind(["permission"]), "permission");
    assert.equal(primaryAttentionKind([]), null);
});

test("title keys map reasons and kinds", () => {
    assert.equal(runEndTitleKey("succeeded"), "Run finished");
    assert.equal(runEndTitleKey("failed"), "Run failed");
    assert.equal(attentionTitleKey("work"), "Work report awaiting review");
    assert.equal(attentionTitleKey("plan"), "Plan awaiting approval");
    assert.equal(attentionTitleKey("question"), "AI asked you a question");
    assert.equal(attentionTitleKey("permission"), "An action needs your approval");
});

function session(fields: Partial<OpencodeSession>): OpencodeSession {
    return {id: "s1", projectID: "p1", ...fields};
}

test("notifySubject prefers the title, then the folder label, then the app name", () => {
    assert.equal(notifySubject(session({title: "Fix the login bug"})), "Fix the login bug");
    // Auto-generated placeholders/blank titles fall through.
    assert.equal(notifySubject(session({title: "  ", directory: "/home/u/work/lumina-code"})), "lumina-code");
    assert.equal(notifySubject(session({location: {directory: "C:\\dev\\项目 检查"}})), "项目 检查");
    assert.equal(notifySubject(session({})), "Lumina Code");
});
