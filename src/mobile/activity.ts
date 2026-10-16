import type {ChatMessage} from "../opencode/types.ts";
import {
    collectSessionShells,
    collectSessionSubagents,
    collectSessionTodos,
    fileMutationCount,
    type SessionShellRef,
    type SessionSubagentRef,
    type SessionTodos,
} from "../opencode/sessionActivity.ts";

/**
 * Pure derivation of the mobile WORKSPACE ACTIVITY view from a session's
 * mirrored message snapshot — the same folds the desktop's stats panel
 * runs (sessionActivity.ts is the single source; the mirror carries all
 * their inputs). The changes COUNT comes from the transcript; the
 * per-file diff detail is the separate mirror link (task 5).
 *
 * Visibility rules mirror the desktop's card: current-turn items (spawned
 * at/after the last user message) plus anything that never reported
 * completion — old finished shells/subagents fold away.
 */

export interface MobileActivity {
    todos: SessionTodos | null;
    shells: SessionShellRef[];
    subagents: SessionSubagentRef[];
    /** Files touched by this session's tools (transcript-derived count). */
    fileEdits: number;
}

export function deriveActivity(messages: readonly ChatMessage[]): MobileActivity {
    const list = messages as ChatMessage[];
    return {
        todos: collectSessionTodos(list),
        // Old FINISHED shells fold away; running ones and the current
        // turn's stay (the desktop card's rule, minus its live state).
        shells: collectSessionShells(list).filter(
            (s) => s.currentTurn || !s.finished,
        ),
        // Subagents carry no finished flag (deduped by child id) — the
        // current turn's spawn set is the meaningful view.
        subagents: collectSessionSubagents(list).filter((s) => s.currentTurn),
        fileEdits: fileMutationCount(list),
    };
}

export function isActivityEmpty(activity: MobileActivity): boolean {
    return (
        activity.todos === null &&
        activity.shells.length === 0 &&
        activity.subagents.length === 0
    );
}
