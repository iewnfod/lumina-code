import {useEffect, useSyncExternalStore} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import type {WorkspaceDiffEntry} from "./types.ts";

/**
 * The per-turn EDIT SUMMARY store: one entry per (session, user message)
 * pair holding the files that prompt's TURN changed and the summed
 * line counts — the data behind the run footer's edits chip
 * (api.sessionTurnDiff, the server's snapshot-based per-turn diff).
 *
 * Module store + useSyncExternalStore binding (the sessionStopping /
 * useSessionMessages snapshot pattern): a turn's diff is IMMUTABLE once
 * the turn ended (snapshots never change), so entries cache forever,
 * in-flight calls dedupe, and remounting footers (session switches,
 * scroll-back renders) cost nothing. Entries drop with their session
 * (`session.deleted`, folded from useSessions' global bus handler).
 *
 * Failures (snapshot-less project — no git or `snapshot: false` in the
 * server config — or a transient error) settle as `error` and the chip
 * simply doesn't render; no retry, matching the plan's honest-degradation
 * rule: no snapshot data, no summary.
 */

/** One turn's file-edit summary (immutable once `ready`). */
export interface TurnEdits {
    status: "loading" | "ready" | "error";
    /** Per-file diffs as the server computed them (patch text unused). */
    files: WorkspaceDiffEntry[];
    /** Summed additions/deletions across {@link files}. */
    added: number;
    removed: number;
}

/** Sum a server turn-diff into the footer's line totals. Pure. */
export function summarizeTurnDiff(files: WorkspaceDiffEntry[]): {added: number; removed: number} {
    let added = 0;
    let removed = 0;
    for (const f of files) {
        added += f.additions;
        removed += f.deletions;
    }
    return {added, removed};
}

const entries = new Map<string, TurnEdits>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

function key(sessionId: string, userMessageId: string): string {
    return `${sessionId}\0${userMessageId}`;
}

/** Fetch a turn's diff once (idempotent — later calls with the same key
 *  are no-ops whether loading, ready or errored). Nullish ids no-op so
 *  callers don't have to pre-gate. */
export function ensureTurnEdits(
    api: OpencodeApi | null,
    sessionId: string | null,
    userMessageId: string | null,
): void {
    if (!api || !sessionId || !userMessageId) return;
    const k = key(sessionId, userMessageId);
    if (entries.has(k)) return;
    entries.set(k, {status: "loading", files: [], added: 0, removed: 0});
    emit();
    api.sessionTurnDiff(sessionId, userMessageId).then((files) => {
        const totals = summarizeTurnDiff(files);
        entries.set(k, {status: "ready", files, added: totals.added, removed: totals.removed});
        emit();
    }).catch((e) => {
        logError(`Failed to load turn diff for ${sessionId}/${userMessageId}: ${e}`).catch(() => {});
        entries.set(k, {status: "error", files: [], added: 0, removed: 0});
        emit();
    });
}

/** Drop a deleted session's entries (folded from the global bus handler;
 *  unrelated event types no-op). */
export function applyTurnEditsBusEvent(type: string, sessionID: unknown): void {
    if (type !== "session.deleted" || typeof sessionID !== "string") return;
    const prefix = `${sessionID}\0`;
    let dropped = false;
    for (const k of entries.keys()) {
        if (k.startsWith(prefix)) {
            entries.delete(k);
            dropped = true;
        }
    }
    if (dropped) emit();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

const NO_EDITS: TurnEdits = {status: "loading", files: [], added: 0, removed: 0};

/** The turn-edit summary for one (session, user message) pair; mounts
 *  also ensure the fetch. Nullish ids read as a permanent loading state
 *  (callers with no user message simply never render the chip). */
export function useTurnEdits(
    api: OpencodeApi | null,
    sessionId: string | null,
    userMessageId: string | null,
): TurnEdits {
    const entry = useSyncExternalStore(
        subscribe,
        () =>
            sessionId !== null && userMessageId !== null
                ? entries.get(key(sessionId, userMessageId)) ?? null
                : null,
        () => null,
    );
    useEffect(() => {
        ensureTurnEdits(api, sessionId, userMessageId);
    }, [api, sessionId, userMessageId]);
    return entry ?? NO_EDITS;
}
