import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_TYPOGRAPHY,
    fontFamilyOverride,
    isDefaultTypography,
    sanitizeTypography,
} from "./typography.ts";

test("sanitizeTypography returns defaults for non-object input", () => {
    assert.deepEqual(sanitizeTypography(null), DEFAULT_TYPOGRAPHY);
    assert.deepEqual(sanitizeTypography("Sans Serif"), DEFAULT_TYPOGRAPHY);
    assert.deepEqual(sanitizeTypography(undefined), DEFAULT_TYPOGRAPHY);
});

test("sanitizeTypography accepts a valid partial object", () => {
    assert.deepEqual(
        sanitizeTypography({sansFamily: "Noto Serif", uiSizePx: 18, codeSizePx: 11}),
        {sansFamily: "Noto Serif", monoFamily: "", uiSizePx: 18, codeSizePx: 11},
    );
});

test("sanitizeTypography clamps sizes into range and rounds", () => {
    const s = sanitizeTypography({uiSizePx: 99, codeSizePx: 1});
    assert.equal(s.uiSizePx, 20);
    assert.equal(s.codeSizePx, 10);
    const r = sanitizeTypography({uiSizePx: 14.6});
    assert.equal(r.uiSizePx, 15);
});

test("sanitizeTypography falls back per-field on garbage", () => {
    const s = sanitizeTypography({sansFamily: 42, uiSizePx: "eight", monoFamily: "JetBrains Mono"});
    assert.equal(s.sansFamily, "");
    assert.equal(s.uiSizePx, 16);
    assert.equal(s.monoFamily, "JetBrains Mono");
});

test("sanitizeTypography trims families and caps length", () => {
    assert.equal(sanitizeTypography({sansFamily: "  Mapo  "}).sansFamily, "Mapo");
    const long = "x".repeat(300);
    assert.ok(sanitizeTypography({sansFamily: long}).sansFamily.length <= 128);
});

test("isDefaultTypography only true at full defaults", () => {
    assert.ok(isDefaultTypography(DEFAULT_TYPOGRAPHY));
    assert.ok(!isDefaultTypography({...DEFAULT_TYPOGRAPHY, uiSizePx: 17}));
    assert.ok(!isDefaultTypography({...DEFAULT_TYPOGRAPHY, sansFamily: "Arial"}));
});

test("fontFamilyOverride quotes, escapes, and appends the fallback stack", () => {
    assert.equal(fontFamilyOverride("思源黑体", "system-ui, sans-serif"), '"思源黑体", system-ui, sans-serif');
    assert.equal(fontFamilyOverride('Weird "Font" \\', "serif"), '"Weird \\"Font\\" \\\\", serif');
    assert.equal(fontFamilyOverride("Single", ""), '"Single"');
});

test("fontFamilyOverride is empty for blank families", () => {
    assert.equal(fontFamilyOverride("", "system-ui"), "");
    assert.equal(fontFamilyOverride("   ", "system-ui"), "");
});
