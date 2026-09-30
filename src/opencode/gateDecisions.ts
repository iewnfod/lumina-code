import {createPersistedStore} from "../lib/persistedStore.ts";
import type {GateDecision} from "./sessionActivity.ts";

/**
 * Locally recorded verdicts for restart-ORPHANED gate parts (see
 * sessionActivity.ts's GateContext): when the app dies while a
 * plan_submit / work_submit executor blocks in its poll gate, the part
 * stays frozen "running" in the server's storage forever — the verdict
 * the user clicks afterwards can only settle on THIS side. The record
 * keys decisions by session → part id and survives restarts through the
 * persistence factory, so a decided card never resurfaces.
 *
 * Plan APPROVALS need no record: they are delivered as the agent switch
 * (switchAgent "build"), which the server persists itself. Work
 * ACCEPTANCES are additionally durable as the review marker file the
 * executor protocol defines (.lumina/review/{sessionID}.json) — the
 * record here only mirrors it for the transcript folds. Entries are
 * deliberately never cleaned: they are rare, one line each, and a
 * deleted session's record is inert (folds consult decisions only for
 * parts that exist in the transcript).
 */
export type GateDecisions = Readonly<Record<string, Record<string, GateDecision>>>;

const store = createPersistedStore<GateDecisions>({
    key: "lumina-code:gate-decisions",
    label: "gate decisions",
    read: (raw) => {
        if (raw === null) return {};
        try {
            const parsed: unknown = JSON.parse(raw);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
            const out: Record<string, Record<string, GateDecision>> = {};
            for (const [sessionID, decisions] of Object.entries(parsed as Record<string, unknown>)) {
                if (decisions === null || typeof decisions !== "object" || Array.isArray(decisions)) continue;
                const clean: Record<string, GateDecision> = {};
                for (const [partId, decision] of Object.entries(decisions as Record<string, unknown>)) {
                    if (decision === "rejected" || decision === "accepted") clean[partId] = decision;
                }
                if (Object.keys(clean).length > 0) out[sessionID] = clean;
            }
            return out;
        } catch {
            return {};
        }
    },
    write: (value) => JSON.stringify(value),
});

/** Record a verdict for one gate part (the newest verdict for a part
 * wins; same-value rewrites short-circuit inside the store). */
export function recordGateDecision(sessionID: string, partId: string, decision: GateDecision): void {
    const next: Record<string, Record<string, GateDecision>> = {...store.get()};
    const perSession = {...(next[sessionID] ?? {})};
    perSession[partId] = decision;
    next[sessionID] = perSession;
    store.set(next);
}

/** useSyncExternalStore subscription over the record. */
export function subscribeGateDecisions(listener: () => void): () => void {
    return store.subscribe(listener);
}

/** Snapshot for useSyncExternalStore (referentially stable between
 * sets). */
export function getGateDecisionsSnapshot(): GateDecisions {
    return store.get();
}
