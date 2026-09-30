import test from "node:test";
import assert from "node:assert/strict";

// The sidebar-width module creates its persisted store at MODULE LOAD —
// persistedStore reads localStorage synchronously at creation — so the
// memory mock (and the pre-seeded key under test) must be installed
// BEFORE the import itself. Static imports hoist above any module-body
// code, so persistedStore.test.ts's trick doesn't transfer; a dynamic
// import keeps the order guaranteed.
class MemoryStorage {
    private map = new Map<string, string>();
    getItem(key: string): string | null {
        return this.map.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
        this.map.set(key, value);
    }
    removeItem(key: string): void {
        this.map.delete(key);
    }
    peek(key: string): string | null {
        return this.map.get(key) ?? null;
    }
}

const storage = new MemoryStorage();
(globalThis as {localStorage: unknown}).localStorage = storage;

// A pre-seeded stored width: proves the creation-time read picks it up.
storage.setItem("lumina-code:sidebar-width", "300");

const {
    SIDEBAR_DEFAULT_WIDTH,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
    clampSidebarWidth,
    getSidebarWidth,
    setSidebarWidth,
} = await import("./useSidebarWidth.ts");

test("clampSidebarWidth: garbage falls back to the default", () => {
    assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_DEFAULT_WIDTH);
    assert.equal(clampSidebarWidth(Number.POSITIVE_INFINITY), SIDEBAR_DEFAULT_WIDTH);
});

test("clampSidebarWidth: real numbers clamp to [MIN, MAX], whole pixels", () => {
    assert.equal(clampSidebarWidth(0), SIDEBAR_MIN_WIDTH);
    assert.equal(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 1), SIDEBAR_MIN_WIDTH);
    assert.equal(clampSidebarWidth(9999), SIDEBAR_MAX_WIDTH);
    assert.equal(clampSidebarWidth(260), 260);
    assert.equal(clampSidebarWidth(240.6), 241);
});

test("the store reads a persisted width at creation", () => {
    assert.equal(getSidebarWidth(), 300);
});

test("setSidebarWidth clamps and persists", () => {
    setSidebarWidth(9999);
    assert.equal(getSidebarWidth(), SIDEBAR_MAX_WIDTH);
    assert.equal(storage.peek("lumina-code:sidebar-width"), String(SIDEBAR_MAX_WIDTH));
});

test("setSidebarWidth removes the key at the default (absence = default)", () => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    assert.equal(getSidebarWidth(), SIDEBAR_DEFAULT_WIDTH);
    assert.equal(storage.peek("lumina-code:sidebar-width"), null);
});
