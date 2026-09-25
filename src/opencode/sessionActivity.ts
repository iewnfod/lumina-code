import {isAssistantMessage} from "./types.ts";
import type {AssistantToolPart, ChatMarkerMessage, ChatMessage} from "./types.ts";

/**
 * Pure session-activity derivations for the stats card: the background
 * terminals and subagent child sessions a session's OWN messages reveal,
 * extracted from stored tool-part metadata (verified against server
 * v2.0.11 — see useSessionActivity.ts for what's live vs. historical).
 *
 * Pure: no React — node-testable (sessionActivity.test.ts).
 */

/** Shell-executing tools (v2.0.x names the tool "shell"; bash/powershell
 * spellings kept for older builds). */
export function isShellToolName(name: string): boolean {
    return name === "bash" || name === "shell" || name === "power_shell";
}

/** The subagent spawn tool — "subagent" today, "task" on older servers. */
export function isSubagentToolName(name: string): boolean {
    return name === "subagent" || name === "task";
}

/** File-mutating tools — a change in their count is the signal to re-pull
 * the session diff (the diff endpoint compares snapshots server-side). */
export function isFileMutatingToolName(name: string): boolean {
    return name === "edit" || name === "write" || name === "apply_patch" || name === "patch";
}

/** One background terminal of a session. Only BACKGROUND invocations
 * carry `metadata.shellID` (a shell moved off the foreground returns
 * immediately with it; foreground results never do). */
export interface SessionShellRef {
    id: string; // "sh_…"
    command: string;
    /** The tool part that spawned it. */
    partId: string;
    /** The completion notification has landed (a message whose metadata
     * names this shell) — the command is no longer running. */
    finished: boolean;
    /** Completion state from that notification, when it arrived
     * ("completed" | "cancelled" | "error"). */
    state?: string;
    /** Exit code from the notification, when it carried one. */
    exit?: number;
    /** The notification's own text — the command's final output plus the
     *  server's status line. Falls back into the detail view when the
     *  shell registry no longer knows the shell (it is process-local: a
     *  server restart orphans exited shells and their output endpoint). */
    finalText?: string;
    /** Spawned (or re-referenced) at/after the last user message. The
     * stats card keeps completed items from the current turn only;
     * running ones stay visible whatever their age — running state lives
     * in useSessionActivity, so the filtering happens there. */
    currentTurn: boolean;
}

/** One subagent child session spawned by this session. */
export interface SessionSubagentRef {
    id: string; // child session id
    /** Subagent kind from the spawn input ("explore", "review", …). */
    agent?: string;
    /** The 3-5 word task label the caller sent. */
    label?: string;
    /** Spawned (or continued) at/after the last user message — see
     * SessionShellRef.currentTurn for the filtering contract. */
    currentTurn: boolean;
}

/** First present, non-empty string among the given keys. */
function metaString(o: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const v = o[key];
        if (typeof v === "string" && v) return v;
    }
    return undefined;
}

function toolParts(list: ChatMessage[]): AssistantToolPart[] {
    const parts: AssistantToolPart[] = [];
    for (const m of list) {
        if (!isAssistantMessage(m)) continue;
        for (const part of m.content) {
            if (part.type === "tool") parts.push(part);
        }
    }
    return parts;
}

/** Index of the last server-confirmed user message — the anchor of the
 * "current turn". Optimistic local- bubbles don't count (same rule as
 * mutationSignature); -1 when the list holds none (then everything is
 * current — e.g. a child transcript or a fresh session). */
function lastConfirmedUserIndex(list: ChatMessage[]): number {
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m.type === "user" && !m.id.startsWith("local-")) return i;
    }
    return -1;
}

/** Tool parts with their turn membership: whether the carrying message
 * sits at/after the last user message (a subagent CONTINUED in the
 * current turn counts as current activity, hence the or-backfill below). */
function toolPartsWithTurn(list: ChatMessage[]): {part: AssistantToolPart; currentTurn: boolean}[] {
    const anchor = lastConfirmedUserIndex(list);
    const parts: {part: AssistantToolPart; currentTurn: boolean}[] = [];
    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!isAssistantMessage(m)) continue;
        const currentTurn = anchor < 0 || i > anchor;
        for (const part of m.content) {
            if (part.type === "tool") parts.push({part, currentTurn});
        }
    }
    return parts;
}

/**
 * The session's background terminals in spawn order. A shell's completion
 * arrives as a notification message carrying
 * `metadata: {source: "shell", shellID, state, exit?}` — the collector
 * marks the referenced shell finished (regardless of the message's own
 * `type`, which has drifted across server builds).
 */
export function collectSessionShells(list: ChatMessage[]): SessionShellRef[] {
    const byId = new Map<string, SessionShellRef>();
    for (const {part, currentTurn} of toolPartsWithTurn(list)) {
        if (!isShellToolName(part.name)) continue;
        const meta = part.state.metadata;
        const id = meta ? metaString(meta, "shellID", "shell_id") : undefined;
        if (!id) continue;
        const input =
            part.state.input && typeof part.state.input === "object"
                ? (part.state.input as Record<string, unknown>)
                : {};
        const command = metaString(input, "command", "command_str") ?? "";
        const existing = byId.get(id);
        if (existing) {
            if (!existing.command && command) existing.command = command;
            existing.currentTurn ||= currentTurn;
            continue;
        }
        byId.set(id, {id, command, partId: part.id, finished: false, currentTurn});
    }
    if (byId.size === 0) return [];
    // Completion notifications can be marker-typed messages ("shell",
    // "synthetic", …) — match on metadata, not message type.
    for (const m of list) {
        if (m.type === "user" || m.type === "assistant") continue;
        const meta = (m as ChatMarkerMessage).metadata;
        if (!meta || metaString(meta, "source") !== "shell") continue;
        const id = metaString(meta, "shellID", "shell_id");
        const ref = id ? byId.get(id) : undefined;
        if (!ref) continue;
        ref.finished = true;
        ref.state = metaString(meta, "state");
        const exit = meta.exit;
        if (typeof exit === "number") ref.exit = exit;
        // The notification text embeds the final output — the only copy
        // that survives a server restart (the shell registry doesn't).
        const text = (m as ChatMarkerMessage & {text?: unknown}).text;
        if (typeof text === "string" && text.trim() !== "") ref.finalText = text;
    }
    return [...byId.values()];
}

/**
 * The session's subagent children in spawn order, deduped by child id —
 * the model may CONTINUE an earlier subagent by passing its sessionID,
 * which must not read as a second agent. The child id rides the tool
 * part's `metadata.sessionID` (set on both running-background and
 * completed results); parts without it (older servers) can't be linked.
 */
export function collectSessionSubagents(list: ChatMessage[]): SessionSubagentRef[] {
    const byId = new Map<string, SessionSubagentRef>();
    for (const {part, currentTurn} of toolPartsWithTurn(list)) {
        if (!isSubagentToolName(part.name)) continue;
        const id = part.state.metadata ? metaString(part.state.metadata, "sessionID", "session_id") : undefined;
        if (!id) continue;
        const existing = byId.get(id);
        if (existing) {
            // A continuation in the current turn re-surfaces the child
            // as current activity even if it was spawned turns ago.
            existing.currentTurn ||= currentTurn;
            continue;
        }
        const input =
            part.state.input && typeof part.state.input === "object"
                ? (part.state.input as Record<string, unknown>)
                : {};
        byId.set(id, {
            id,
            agent: metaString(input, "agent"),
            label: metaString(input, "description"),
            currentTurn,
        });
    }
    return [...byId.values()];
}

/** How many file-mutating tool parts the list holds (any status) — a cheap
 * change signature that bumps whenever an edit lands. */
export function fileMutationCount(list: ChatMessage[]): number {
    let count = 0;
    for (const part of toolParts(list)) {
        if (isFileMutatingToolName(part.name)) count++;
    }
    return count;
}

/** Change signature of a session's messages: the file-mutating tool count
 * plus the last (server-confirmed) user message id. Its VALUE only moves
 * when an edit landed or a prompt arrived — streamed text/reasoning
 * frames never bump it — which is what gates the activity store's
 * debounced diff re-pulls (backgrounded sessions included). */
export function mutationSignature(list: readonly ChatMessage[]): string {
    let lastUserId = "";
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m.type === "user" && !m.id.startsWith("local-")) {
            lastUserId = m.id;
            break;
        }
    }
    return `${fileMutationCount(list as ChatMessage[])}:${lastUserId}`;
}
