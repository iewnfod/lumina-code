import test from "node:test";
import assert from "node:assert/strict";
import {
    CHAT_COLUMN_CAP_REM,
    CHAT_COLUMN_ROOMY_SIDE_PAD_REM,
    CHAT_COLUMN_SIDE_PAD_REM,
    CHAT_COLUMN_WIDE_CAP_REM,
    chatColumnCapRem,
    chatColumnSidePadRem,
} from "./chatColumn.ts";

// Default zoom: the wide tier engages at 64rem cap + 8rem margin per side = 80rem.
const WIDE_AT_PX = 80 * 16;

test("chatColumnCapRem keeps the base cap below the wide threshold", () => {
    assert.equal(chatColumnCapRem(0, 16), CHAT_COLUMN_CAP_REM);
    assert.equal(chatColumnCapRem(48 * 16, 16), CHAT_COLUMN_CAP_REM);
    assert.equal(chatColumnCapRem(WIDE_AT_PX - 1, 16), CHAT_COLUMN_CAP_REM);
});

test("chatColumnCapRem engages the wide cap at the threshold", () => {
    assert.equal(chatColumnCapRem(WIDE_AT_PX, 16), CHAT_COLUMN_WIDE_CAP_REM);
    assert.equal(chatColumnCapRem(3000, 16), CHAT_COLUMN_WIDE_CAP_REM);
});

test("chatColumnCapRem scales the threshold with the root font size", () => {
    assert.equal(chatColumnCapRem(80 * 20 - 1, 20), CHAT_COLUMN_CAP_REM);
    assert.equal(chatColumnCapRem(80 * 20, 20), CHAT_COLUMN_WIDE_CAP_REM);
});

test("chatColumnCapRem guards a bogus rem", () => {
    assert.equal(chatColumnCapRem(4096, 0), CHAT_COLUMN_CAP_REM);
    assert.equal(chatColumnCapRem(4096, -3), CHAT_COLUMN_CAP_REM);
    assert.equal(chatColumnCapRem(-1, 16), CHAT_COLUMN_CAP_REM);
});

test("chatColumnSidePadRem widens the gutters while the column cannot reach its cap", () => {
    assert.equal(chatColumnSidePadRem(0, 16), CHAT_COLUMN_ROOMY_SIDE_PAD_REM);
    assert.equal(chatColumnSidePadRem(48 * 16 - 1, 16), CHAT_COLUMN_ROOMY_SIDE_PAD_REM);
});

test("chatColumnSidePadRem keeps the compact gutters once the column is capped", () => {
    // At the base cap exactly, and anywhere in the capped wide tier.
    assert.equal(chatColumnSidePadRem(48 * 16, 16), CHAT_COLUMN_SIDE_PAD_REM);
    assert.equal(chatColumnSidePadRem(WIDE_AT_PX - 1, 16), CHAT_COLUMN_SIDE_PAD_REM);
    assert.equal(chatColumnSidePadRem(WIDE_AT_PX, 16), CHAT_COLUMN_SIDE_PAD_REM);
    assert.equal(chatColumnSidePadRem(3000, 16), CHAT_COLUMN_SIDE_PAD_REM);
});

test("chatColumnSidePadRem scales the gutter flip with the root font size", () => {
    assert.equal(chatColumnSidePadRem(48 * 20 - 1, 20), CHAT_COLUMN_ROOMY_SIDE_PAD_REM);
    assert.equal(chatColumnSidePadRem(48 * 20, 20), CHAT_COLUMN_SIDE_PAD_REM);
});

test("chatColumnSidePadRem guards a bogus rem", () => {
    assert.equal(chatColumnSidePadRem(4096, 0), CHAT_COLUMN_ROOMY_SIDE_PAD_REM);
    assert.equal(chatColumnSidePadRem(4096, -3), CHAT_COLUMN_ROOMY_SIDE_PAD_REM);
});
