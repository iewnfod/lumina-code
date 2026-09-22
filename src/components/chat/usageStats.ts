/**
 * Pure helpers behind the composer's session-usage ring: picking the
 * transcript step that owns the context reading, mapping it onto the
 * model's context limit, and the compact label formats (token count,
 * cost). Presentation lives in UsageRing.tsx; these stay framework-free
 * for unit tests.
 */

import {isAssistantMessage, type ChatAssistantMessage, type ChatMessage, type SessionModelRef} from "../../opencode/types.ts";

/** Mirror of the wire shape (`OpencodeSession["tokens"]`). */
export interface UsageTokens {
    input: number;
    output: number;
    reasoning: number;
    cache: {read: number; write: number};
}

/** The ring's data packet: the last measured step's tokens plus the model
 *  that produced them (resolves the context limit). */
export interface ContextUsage {
    tokens: UsageTokens;
    model?: SessionModelRef;
}

/**
 * The step that owns the ring: the LAST assistant message carrying usage.
 * This mirrors the official client's semantics — a step's input already
 * contains the whole prior context, so the last step's tokens ARE the
 * session's current context footprint. Summing across steps (the session
 * aggregate) instead would grow quadratically with every turn.
 *
 * Steps without usage (still streaming), failed steps, and usage whose
 * prompt side is all zeroes are skipped.
 */
export function lastContextMessage(list: ChatMessage[]): ChatAssistantMessage | null {
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (!isAssistantMessage(m) || m.error) continue;
        const t = m.tokens;
        if (!t) continue;
        if ((t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) <= 0) continue;
        return m;
    }
    return null;
}

/**
 * The ring's fraction: current context tokens over the model's context
 * limit, clamped to [0, 1]. Null when the limit is unknown — the ring then
 * renders as an empty track with just the count (no percentage claim).
 */
export function ringFraction(total: number, contextLimit: number | undefined): number | null {
    if (!contextLimit || contextLimit <= 0) return null;
    if (total <= 0) return 0;
    return Math.min(1, total / contextLimit);
}

/** Every bucket added; absent pieces count as zero (wire fields may be
 *  missing even where the type says otherwise). */
export function totalTokens(t: UsageTokens | undefined | null): number {
    if (!t) return 0;
    return (
        (t.input ?? 0) +
        (t.output ?? 0) +
        (t.reasoning ?? 0) +
        (t.cache?.read ?? 0) +
        (t.cache?.write ?? 0)
    );
}

/**
 * Cache hit rate of one step: cache-read tokens over everything the
 * prompt could have hit in cache (input + read + write — the official
 * client's formula). Fraction [0,1]; null when nothing was prompt-side.
 */
export function cacheHitRate(t: UsageTokens | null | undefined): number | null {
    if (!t) return null;
    const total = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    if (total <= 0) return null;
    return (t.cache?.read ?? 0) / total;
}

/** Compact token count for the ring's label: 999 · 1k · 12.3k · 1.2M · 25M. */
export function formatTokens(n: number): string {
    if (n < 1_000) return String(Math.max(0, Math.round(n)));
    const units: [number, string][] = [[1_000_000, "M"], [1_000, "k"]];
    for (const [size, suffix] of units) {
        if (n >= size) {
            const value = (n / size).toFixed(1).replace(/\.0$/, "");
            return `${value}${suffix}`;
        }
    }
    return String(n);
}

/** Cost label: $0.42 · $12.00, sub-cent floors to <$0.01, absent → null. */
export function formatCost(cost: number | undefined): string | null {
    if (cost == null) return null;
    if (cost > 0 && cost < 0.01) return "<$0.01";
    return `$${cost.toFixed(2)}`;
}
