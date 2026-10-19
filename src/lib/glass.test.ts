import test from "node:test";
import assert from "node:assert/strict";
import {
    defaultGlassTint,
    glassSurface,
    glassSurfaceEquivalent,
} from "./glass.ts";

test("defaultGlassTint lightens dark bgs and darkens light ones", () => {
    assert.equal(defaultGlassTint(true), "rgba(255,255,255,0.06)");
    assert.equal(defaultGlassTint(false), "rgba(0,0,0,0.04)");
});

test("glassSurface default tints come from defaultGlassTint", () => {
    // The compositor-blur branch (saturate passed explicitly — the
    // default probes getComputedStyle, which node does not have).
    const dark = glassSurface("#1a1a1a", false, {blurPx: 0, saturate: 1, compositorBlur: true});
    assert.equal(dark.background, defaultGlassTint(true));
    const light = glassSurface("#fafafa", false, {blurPx: 0, saturate: 1, compositorBlur: true});
    assert.equal(light.background, defaultGlassTint(false));
});

test("glassSurfaceEquivalent composites the tint over the base", () => {
    // Dark base: 26 × 0.94 + 255 × 0.06 = 39.74 → 40 (#28). Hex output
    // on purpose — the native consumer (Color.parseColor) needs #rrggbb.
    assert.equal(glassSurfaceEquivalent("#1a1a1a"), "#282828");
    // Light base: 250 × 0.96 + 0 × 0.04 = 240 (#f0).
    assert.equal(glassSurfaceEquivalent("#fafafa"), "#f0f0f0");
});

test("glassSurfaceEquivalent lightens dark and darkens light", () => {
    const channels = (equiv: string) =>
        [1, 3, 5].map((i) => parseInt(equiv.substring(i, i + 2), 16));
    const dark = channels(glassSurfaceEquivalent("#1a1a1a"));
    const light = channels(glassSurfaceEquivalent("#fafafa"));
    for (let i = 0; i < 3; i++) {
        assert.ok(dark[i] > 26, "dark equivalent is lighter than its base");
        assert.ok(light[i] < 250, "light equivalent is darker than its base");
    }
});

test("glassSurfaceEquivalent passes malformed input through", () => {
    assert.equal(glassSurfaceEquivalent("#fff"), "#fff");
});
