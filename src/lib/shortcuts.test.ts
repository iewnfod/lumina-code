import assert from "node:assert/strict";
import test from "node:test";
import {
    chordFromEvent,
    findConflicts,
    formatChord,
    isBindableChord,
    matchChord,
    parseChord,
    resolveBindings,
    sanitizeCustomBindings,
    SHORTCUTS,
} from "./shortcuts.ts";

/** Minimal event factory. */
function ev(key: string, mods: Partial<{metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean}> = {}) {
    return {
        key,
        metaKey: mods.metaKey ?? false,
        ctrlKey: mods.ctrlKey ?? false,
        altKey: mods.altKey ?? false,
        shiftKey: mods.shiftKey ?? false,
        isComposing: mods.isComposing ?? false,
    };
}

// --- chordFromEvent: platform folding ---

test("mod folds Meta on mac, Ctrl elsewhere", () => {
    assert.equal(chordFromEvent(ev("n", {metaKey: true}), true), "mod+n");
    assert.equal(chordFromEvent(ev("n", {ctrlKey: true}), false), "mod+n");
});

test("letters lowercase through shift; segment order is fixed", () => {
    assert.equal(chordFromEvent(ev("N", {metaKey: true, shiftKey: true}), true), "mod+shift+n");
    assert.equal(chordFromEvent(ev("ArrowRight", {ctrlKey: true, altKey: true}), false), "mod+alt+arrowright");
});

test("explicit mac Ctrl survives as its own segment", () => {
    assert.equal(chordFromEvent(ev("k", {metaKey: true, ctrlKey: true}), true), "mod+ctrl+k");
    // Non-mac Ctrl IS mod — no duplicate segment.
    assert.equal(chordFromEvent(ev("k", {ctrlKey: true}), false), "mod+k");
});

test("non-mac Super (meta) is the OS's, never a chord", () => {
    assert.equal(chordFromEvent(ev("n", {metaKey: true}), false), null);
});

test("unbindable events: plain keys, shift-only, modifiers, IME, dead keys, plus", () => {
    assert.equal(chordFromEvent(ev("n"), true), null);
    assert.equal(chordFromEvent(ev("n", {shiftKey: true}), true), null);
    assert.equal(chordFromEvent(ev("Shift", {metaKey: true}), true), null);
    assert.equal(chordFromEvent(ev("Meta"), true), null);
    assert.equal(chordFromEvent(ev("n", {ctrlKey: true, isComposing: true}), false), null);
    assert.equal(chordFromEvent(ev("Dead", {ctrlKey: true}), false), null);
    assert.equal(chordFromEvent(ev("+", {ctrlKey: true}), false), null);
});

test("bare F-keys bind without modifiers", () => {
    assert.equal(chordFromEvent(ev("F2"), true), "f2");
    assert.equal(chordFromEvent(ev("F12"), false), "f12");
    assert.equal(chordFromEvent(ev("F13"), true), null);
});

// --- parseChord ---

test("parseChord accepts canonical forms and rejects garbage", () => {
    assert.deepEqual(parseChord("mod+alt+arrowleft"), {mods: {mod: true, ctrl: false, alt: true, shift: false}, key: "arrowleft"});
    assert.equal(parseChord(""), null);
    assert.equal(parseChord("mod++"), null); // "+" tail illegal
    assert.equal(parseChord("mod+hyper+n"), null); // unknown modifier
    assert.equal(parseChord("mod+mod+n"), null); // duplicate modifier
    assert.equal(parseChord("mod+notakey"), null); // unknown named tail
});

test("parseChord: punctuation, bare F keys; reserved keys are not in chord space", () => {
    const comma = parseChord("mod+,");
    assert.ok(comma);
    assert.equal(comma.key, ",");
    const f2 = parseChord("f2");
    assert.ok(f2);
    assert.equal(f2.key, "f2");
    // escape/tab never enter chord space at all — parsing refuses them, so
    // hand-edited storage rows fall back to defaults via sanitize, and
    // isBindableChord's escape/tab check is cheap belt-and-suspenders.
    assert.equal(parseChord("escape"), null);
    assert.equal(parseChord("mod+tab"), null);
});

// --- isBindableChord ---

test("reserved chords are refused", () => {
    assert.equal(isBindableChord("mod+a"), false); // select-all
    assert.equal(isBindableChord("mod+shift+z"), false); // redo family
    assert.equal(isBindableChord("mod+r"), false); // webview reload
    assert.equal(isBindableChord("f5"), false);
    assert.equal(isBindableChord("mod+f5"), false);
    assert.equal(isBindableChord("escape"), false);
    assert.equal(isBindableChord("mod+tab"), false);
    assert.equal(isBindableChord("shift+a"), false); // shift-only letter
    assert.equal(isBindableChord("a"), false); // plain key
});

test("alt (or mac-ctrl) rescues the reserved letters; normal chords pass", () => {
    assert.equal(isBindableChord("mod+alt+a"), true);
    assert.equal(isBindableChord("mod+ctrl+a"), true); // mac-style explicit ctrl
    assert.equal(isBindableChord("mod+n"), true);
    assert.equal(isBindableChord("mod+alt+arrowright"), true);
    assert.equal(isBindableChord("f2"), true);
    assert.equal(isBindableChord("mod+,"), true);
});

// --- resolveBindings / matchChord / findConflicts ---

test("resolveBindings: overrides win, garbage falls back to defaults", () => {
    const bindings = resolveBindings({newSession: "mod+shift+t", toggleSettings: "garbage!!"});
    assert.equal(bindings.newSession, "mod+shift+t");
    const def = SHORTCUTS.find((s) => s.id === "toggleSettings");
    assert.ok(def);
    assert.equal(bindings.toggleSettings, def.defaultChord);
});

test("matchChord: first registry action wins on conflicts", () => {
    const bindings = resolveBindings({focusComposer: "mod+n"}); // collides with newSession
    assert.equal(matchChord("mod+n", bindings), "newSession");
    assert.equal(matchChord("mod+l", bindings), null); // focusComposer moved OFF it
    assert.equal(matchChord(null, bindings), null);
});

test("matchChord resolves every default chord to its action", () => {
    const bindings = resolveBindings({});
    for (const def of SHORTCUTS) {
        assert.equal(matchChord(def.defaultChord, bindings), def.id, def.id);
    }
});

test("findConflicts flags duplicated chords only", () => {
    const bindings = resolveBindings({focusComposer: "mod+n"});
    const conflicts = findConflicts(bindings);
    assert.deepEqual(conflicts.get("mod+n"), ["newSession", "focusComposer"]);
    // Chords vacated by the override disappear from the map entirely.
    assert.equal(conflicts.has("mod+l"), false);
    assert.equal(conflicts.get("mod+.")?.length, 1);
});

// --- sanitizeCustomBindings ---

test("sanitizeCustomBindings drops unknown actions, non-strings and malformed chords", () => {
    assert.deepEqual(
        sanitizeCustomBindings({
            newSession: "mod+shift+n", // keep
            bogusAction: "mod+x", // unknown id
            toggleSettings: 42, // not a string
            interruptSession: "not a chord", // malformed
            focusComposer: "mod+f2", // keep (legal F-key chord)
        }),
        {newSession: "mod+shift+n", focusComposer: "mod+f2"},
    );
    assert.deepEqual(sanitizeCustomBindings(null), {});
    assert.deepEqual(sanitizeCustomBindings("mod+n"), {});
});

// --- formatChord ---

test("formatChord: mac symbols vs full names, arrow glyphing", () => {
    assert.equal(formatChord("mod+shift+n", true), "⌘⇧N");
    assert.equal(formatChord("mod+alt+arrowright", true), "⌘⌥→");
    assert.equal(formatChord("mod+ctrl+k", true), "⌘⌃K");
    assert.equal(formatChord("mod+shift+n", false), "Ctrl+Shift+N");
    assert.equal(formatChord("mod+alt+arrowleft", false), "Ctrl+Alt+←");
    assert.equal(formatChord("mod+,", false), "Ctrl+,");
    assert.equal(formatChord("f2", false), "F2");
});
