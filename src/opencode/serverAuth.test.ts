import {test} from "node:test";
import assert from "node:assert/strict";
import {nextServerFormState, validateSignInInput} from "./serverAuth.ts";

test("validateSignInInput rejects non-http urls", () => {
    assert.deepEqual(validateSignInInput("ftp://x", "u", "p"), {error: "bad-url"});
    assert.deepEqual(validateSignInInput("not a url", "u", "p"), {error: "bad-url"});
});

test("validateSignInInput rejects empty credentials", () => {
    assert.deepEqual(validateSignInInput("https://s.example", "", "p"), {error: "missing-credentials"});
    assert.deepEqual(validateSignInInput("https://s.example", "u", ""), {error: "missing-credentials"});
});

test("validateSignInInput normalizes and passes a healthy form", () => {
    const ok = validateSignInInput("https://S.example/", "user", "pass");
    assert.equal("error" in ok, false);
    if (!("error" in ok)) assert.equal(ok.url, "https://s.example");
});

test("nextServerFormState expands EMPTY and collapses to the official default", () => {
    // expanding (custom=false → true): the box starts empty
    assert.deepEqual(nextServerFormState(false), {url: "", custom: true});
    // collapsing (custom=true → false): the official default returns
    assert.deepEqual(nextServerFormState(true), {url: "https://lumina-code-server.iewnfod.com", custom: false});
});
