/**
 * The mobile BACK-LEVEL STACK — the frontend half of the system-back
 * integration. The app is a state-driven SPA with no router; its "page
 * levels" (modals, the settings second-level page, the drawer, popover
 * menus, the expanded stats overlay) are React state, invisible to the
 * OS. On Android the system back gesture/button must therefore close
 * the TOP level instead of finishing the activity — this module wires
 * those levels into the WEBVIEW HISTORY, which wry's built-in back
 * routing (re-enabled in MainActivity via handleBackNavigation) drives:
 * canGoBack() → goBack() while a level is open, default finish at the
 * root (the Android convention).
 *
 * Mechanism: every level that opens pushes one history entry carrying
 * {lumId} (URL unchanged); a popstate that lands BELOW our stack top
 * closes levels down to the landing entry; a level closed through its
 * own UI (X button / backdrop / item click) drops its entry via a
 * microtasked history.go(-n). Consumed through hooks/useBackLevel.ts,
 * which gates everything on isMobileApp() — desktop keeps its
 * Escape/backdrop closes and an untouched history.
 *
 * The ordering traps this exists to survive (each has a test):
 * - React unmounts children FIRST, so a parent closing with children
 *   open (the settings X from a second-level page) drops its whole
 *   segment — the separate drops coalesce into ONE go(-n) in the
 *   flush microtask.
 * - A close and a DIFFERENT open in the same commit (the drawer's
 *   import entry) must not pop the just-pushed successor: the flush
 *   SKIPS its go when any push happened since the drop batch — the
 *   stale entry stays buried and is consumed later by the CASCADE.
 * - The cascade: a popstate that lands on a stale (already-closed)
 *   lumId while no live levels remain issues one more go(-1), chained
 *   through subsequent popstates until the base entry — so "close via
 *   X, then back" exits without a dead press. It only fires while the
 *   stack is empty, so it can never skip a live level.
 * - StrictMode's synchronous push→drop→push double-invoke is the same
 *   flush-skip case (the dropped entry becomes a buried stale).
 *
 * Known accepted race: a UI close racing a system back in the same
 * instant can close one level too many (the classic PWA history-stack
 * hazard — both pops land after both closes). Rare enough to accept;
 * every close path is idempotent.
 *
 * Degradation ladder (the persistedStore pattern): a browser binds
 * window.history lazily on first push (the popstate listener rides
 * along — before the first push there is nothing to close, so an
 * un-listened popstate is harmless); node tests inject a fake driver
 * via bindBackHistory and drive the popstate core directly through
 * backStackHandlePop; unbound (and non-window) environments keep the
 * stack logic with no-op history writes.
 */

/** The history writes this module needs — window.history in the app,
 * a recording fake in tests. */
export interface BackHistoryDriver {
    /** history.pushState(state, "") — same URL, never navigates. */
    pushState(state: unknown): void;
    /** history.go(delta) — asynchronous traversal; fires popstate. */
    go(delta: number): void;
}

/** One open level: its identity in history state + how it closes. */
interface BackLevel {
    id: number;
    close: () => void;
}

/** Live levels, bottom (opened first) → top. */
const stack: BackLevel[] = [];
let driver: BackHistoryDriver | null = null;
let bound = false;
let nextId = 1;
/** History entries dropped by UI closes, not yet popped. */
let pendingPop = 0;
/** A push happened since the pending drops were queued — the flush
 * must NOT fire its go (it would pop the new entry off). */
let pushedSinceDrop = false;

/** Bind a history driver. The app's binding happens lazily inside
 * backStackPush (window must exist); tests bind a fake and re-bind
 * between cases. */
export function bindBackHistory(d: BackHistoryDriver): void {
    driver = d;
}

/** Test-only: isolate a case (production never re-binds). */
export function resetBackStackForTests(): void {
    stack.length = 0;
    pendingPop = 0;
    pushedSinceDrop = false;
    driver = null;
}

/** The browser binding: window.history + the popstate listener. */
function ensureBound(): void {
    if (bound || typeof window === "undefined" || typeof window.history === "undefined") return;
    bound = true;
    driver = {
        pushState: (state) => window.history.pushState(state, ""),
        go: (delta) => window.history.go(delta),
    };
    window.addEventListener("popstate", (e) => {
        backStackHandlePop((e.state as {lumId?: number} | null)?.lumId ?? null);
    });
}

/**
 * A level opened. Pushes one history entry ({lumId}, URL unchanged) and
 * registers the close callback the popstate core invokes. Returns the
 * id its cleanup passes to backStackDrop.
 */
export function backStackPush(close: () => void): number {
    ensureBound();
    const id = nextId++;
    stack.push({id, close});
    pushedSinceDrop = true;
    driver?.pushState({lumId: id});
    return id;
}

/**
 * A level closed ITSELF (its own UI — X button, backdrop tap, item
 * click; the useBackLevel cleanup). Removes the level and everything
 * above it from the stack — nested levels close with their parent —
 * invoking THEIR closers (the initiator's own close is skipped: its
 * surface is already closing) and queues one coalesced history.pop in
 * a microtask. No-op for an unknown id (the popstate path removes the
 * entry first; the cleanup's drop then finds nothing).
 */
export function backStackDrop(id: number): void {
    const idx = stack.findIndex((level) => level.id === id);
    if (idx < 0) return;
    // A NEW drop batch starts here: pushes from BEFORE the batch (the
    // levels' own opening pushes) must not count as "a push happened
    // since the drops" — only pushes landing between the batch's start
    // and its flush microtask do.
    if (pendingPop === 0) pushedSinceDrop = false;
    const removed = stack.splice(idx);
    pendingPop += removed.length;
    for (const level of removed) {
        if (level.id !== id) level.close();
    }
    queueMicrotask(flush);
}

/**
 * Commit the pending drops: one go(-n) for the whole batch — UNLESS a
 * push happened since (a different level opened in the same commit,
 * e.g. the drawer's import entry, or StrictMode's remount). Popping
 * then would remove the NEW entry off the top; the stale segment
 * stays buried under it instead and the popstate cascade consumes it
 * after the successor eventually closes.
 */
function flush(): void {
    const delta = pendingPop;
    const skip = pushedSinceDrop;
    pendingPop = 0;
    pushedSinceDrop = false;
    if (delta > 0 && !skip) driver?.go(-delta);
}

/**
 * The popstate core (the browser listener calls this with the landed
 * entry's lumId, tests call it directly). `landed` is the lumId of the
 * history entry we now sit on, or null at the base entry.
 *
 * - landed === stack top → our own flush's landing: nothing to close.
 * - otherwise → the system went back: close levels from the top until
 *   the top matches the landing entry (one close per popped level —
 *   covers single and rapid multi backs alike).
 * - cascade: sitting on a STALE lumId (a UI-closed level's abandoned
 *   entry) with no live levels left → one more go(-1), chaining until
 *   the base entry, so back-at-root still exits without dead presses.
 *   Safe by construction: it only fires while the stack is empty.
 */
export function backStackHandlePop(landed: number | null): void {
    if (stack.length > 0 && stack[stack.length - 1].id === landed) return;
    while (stack.length > 0 && stack[stack.length - 1].id !== landed) {
        stack.pop()!.close();
    }
    if (stack.length === 0 && typeof landed === "number") {
        driver?.go(-1);
    }
}

/** Test/debug surface: how many live levels the stack holds. */
export function backStackSize(): number {
    return stack.length;
}
