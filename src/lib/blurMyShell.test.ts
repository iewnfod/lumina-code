import test from "node:test";
import assert from "node:assert/strict";
import {
    bmsWildcardMatch,
    composeWhitelist,
    deriveBmsStatus,
    type BlurSnapshot,
} from "./blurMyShell.ts";

function snapshot(overrides: Partial<BlurSnapshot> = {}): BlurSnapshot {
    return {
        gnome: true,
        installed: true,
        extensionEnabled: true,
        blur: true,
        enableAll: false,
        staticBlur: false,
        opacity: 215,
        whitelist: [],
        blacklist: [],
        wmClass: "lumina-code",
        ...overrides,
    };
}

test("bmsWildcardMatch mirrors the extension's wildcard semantics", () => {
    // Literal match, case-insensitive (X11 reports "Lumina-code").
    assert.ok(bmsWildcardMatch("lumina-code", "lumina-code"));
    assert.ok(bmsWildcardMatch("lumina-code", "Lumina-code"));
    // Whole-string only — no substring hits.
    assert.ok(!bmsWildcardMatch("lumina", "lumina-code"));
    // `*` any sequence (incl. empty), `?` exactly one char.
    assert.ok(bmsWildcardMatch("lum*", "lumina-code"));
    assert.ok(bmsWildcardMatch("*code*", "lumina-code"));
    assert.ok(bmsWildcardMatch("lumina-code*", "lumina-code"));
    assert.ok(bmsWildcardMatch("lumin?-code", "lumina-code"));
    assert.ok(!bmsWildcardMatch("lumin??-code", "lumina-code"));
    // Regex metacharacters in a pattern stay literal.
    assert.ok(!bmsWildcardMatch("lumina.code", "luminaXcode"));
    assert.ok(bmsWildcardMatch("lumina.code", "lumina.code"));
    assert.ok(bmsWildcardMatch("(code)*", "(code)*"));
    // Empty sides never match (the extension guards both too).
    assert.ok(!bmsWildcardMatch("", "lumina-code"));
    assert.ok(!bmsWildcardMatch("lumina-code", ""));
});

test("deriveBmsStatus follows the extension's decision chain", () => {
    assert.equal(deriveBmsStatus(snapshot({gnome: false})).state, "unsupported");
    assert.equal(deriveBmsStatus(snapshot({installed: false})).state, "notInstalled");
    // A present-but-disabled extension never blurs — this gates the
    // chain BEFORE the applications switch (which could read "on"
    // from an earlier session's settings while nothing runs).
    assert.equal(deriveBmsStatus(snapshot({extensionEnabled: false})).state, "extensionDisabled");
    assert.equal(
        deriveBmsStatus(snapshot({extensionEnabled: false, whitelist: ["lumina-code"]})).state,
        "extensionDisabled",
    );
    assert.equal(deriveBmsStatus(snapshot({blur: false})).state, "disabled");
    assert.equal(deriveBmsStatus(snapshot({whitelist: ["firefox"]})).state, "notListed");
    // Whitelist mode: a matching pattern (any wildcard shape) activates.
    assert.equal(
        deriveBmsStatus(snapshot({whitelist: ["Lumina-Code"]})).state,
        "active",
    );
    assert.equal(deriveBmsStatus(snapshot({whitelist: ["lum*"]})).state, "active");
    // enable-all mode flips to the blacklist decision.
    assert.equal(deriveBmsStatus(snapshot({enableAll: true})).state, "active");
    assert.equal(
        deriveBmsStatus(snapshot({enableAll: true, blacklist: ["*code"]})).state,
        "blacklisted",
    );
});

test("deriveBmsStatus carries the active extras", () => {
    const status = deriveBmsStatus(
        snapshot({whitelist: ["lumina-code"], staticBlur: true, opacity: 255}),
    );
    assert.deepEqual(status, {state: "active", staticBlur: true, opacity: 255});
});

test("composeWhitelist appends our wmClass when nothing covers it", () => {
    assert.deepEqual(composeWhitelist([], "lumina-code"), ["lumina-code"]);
    assert.deepEqual(
        composeWhitelist(["firefox", "Alacritty"], "lumina-code"),
        ["firefox", "Alacritty", "lumina-code"],
    );
});

test("composeWhitelist never duplicates a covered entry", () => {
    // Exact (case-insensitive) entry present.
    assert.deepEqual(composeWhitelist(["Lumina-code"], "lumina-code"), ["Lumina-code"]);
    // A wildcard already matching us counts as covered.
    assert.deepEqual(composeWhitelist(["lum*", "firefox"], "lumina-code"), ["lum*", "firefox"]);
});
