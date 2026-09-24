/**
 * Exit-presence gating (pure) — the logic half of the exit engine
 * (components/ui/ExitPresence.tsx renders it).
 *
 * Two concerns live here:
 *
 * 1. EVENT MATCHING — the engine removes a held element when its CSS
 *    exit finishes, signaled by `animationend` / `transitionend`. Those
 *    events BUBBLE, so a child's entrance or a spinner inside the held
 *    tree must not count: a match requires the event's target to BE the
 *    host and its animation/property name to be the one the exit class
 *    runs.
 *
 * 2. THE EXIT BUDGET — a cap on concurrently-held exits app-wide. One
 *    modal closing is invisible; twenty sidebar rows sweeping out at
 *    once (a helper-session sweep, a busy directory going quiet) is a
 *    frame-drop burst. When the budget is exhausted, new exits drop
 *    straight to unmounted — lists stay lively precisely when it
 *    matters. This global accounting is why the engine is a single
 *    primitive instead of per-component timers.
 */

/** How many ANIMATING exits may be held app-wide at once. (Fold-body
 * holds are exempt — they animate nothing themselves; see
 * ExitPresence's `budget` prop.) */
export const EXIT_BUDGET = 16;

/** An exit's CSS identity: which keyframes animation the exit class
 * runs, or which transition property carries the exit's duration. Omit
 * both to finish on the host's first matching event of either kind. */
export interface ExitMatcher {
    animation?: string;
    transition?: string[];
}

/** Does this animationend event belong to the host's own exit? */
export function matchesAnimationEvent(
    event: {target: object; currentTarget: object; animationName: string},
    matcher: ExitMatcher,
): boolean {
    if (event.target !== event.currentTarget) return false;
    return matcher.animation === undefined || event.animationName === matcher.animation;
}

/** Does this transitionend event belong to the host's own exit? */
export function matchesTransitionEvent(
    event: {target: object; currentTarget: object; propertyName: string},
    matcher: ExitMatcher,
): boolean {
    if (event.target !== event.currentTarget) return false;
    return matcher.transition === undefined || matcher.transition.includes(event.propertyName);
}

export interface ExitLedger {
    /** Try to reserve one exit slot; false = over budget (drop now). */
    tryAcquire(): boolean;
    /** Release a slot (idempotent per handle). */
    release(): void;
    /** Slots currently held. */
    readonly active: number;
}

/** Create an exit ledger with the given cap (the app-wide one lives in
 * the component; tests make their own). */
export function createExitLedger(cap: number = EXIT_BUDGET): ExitLedger {
    let active = 0;
    return {
        tryAcquire() {
            if (active >= cap) return false;
            active++;
            return true;
        },
        release() {
            if (active > 0) active--;
        },
        get active() {
            return active;
        },
    };
}

/**
 * Interleave held (exiting) keys back into the live key order, at the
 * positions they occupied relative to surviving neighbors — a row that
 * leaves the middle of a list must collapse IN PLACE, not jump to the
 * end before folding. New live keys (absent from the previous order)
 * don't flush held rows around them: their insertion point relative to
 * rows that are on their way out is ambiguous, and holding position
 * until a known neighbor arrives is the stable choice.
 */
export function mergeExitOrder(prevKeys: string[], liveKeys: string[], heldKeys: string[]): string[] {
    const prevIndex = new Map<string, number>();
    prevKeys.forEach((k, i) => prevIndex.set(k, i));
    const liveSet = new Set(liveKeys);
    const held = heldKeys
        .filter((k) => !liveSet.has(k) && prevIndex.has(k))
        .sort((a, b) => prevIndex.get(a)! - prevIndex.get(b)!);
    const out: string[] = [];
    let cursor = 0;
    let lastPrev = -1;
    for (const key of liveKeys) {
        const p = prevIndex.get(key);
        if (p !== undefined) {
            while (cursor < held.length) {
                const hp = prevIndex.get(held[cursor])!;
                if (hp >= p) break;
                if (hp > lastPrev) out.push(held[cursor]);
                cursor++;
            }
            lastPrev = Math.max(lastPrev, p);
        }
        out.push(key);
    }
    while (cursor < held.length) out.push(held[cursor++]);
    return out;
}
