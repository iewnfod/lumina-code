/**
 * The transcript's message view model — hand-defined from live observation
 * of server v2.0.x. Split from types.ts (the pure wire types stay there)
 * because this family mixes wire shapes with LOCAL-ONLY fields stamped by
 * the frontend's optimistic UI (localKey / sendFailed / command), so the
 * two evolve on different axes (server upgrades vs interaction rework).
 * types.ts re-exports everything from here, so importing from either file
 * keeps working (§3.2 single source).
 */
import type {SessionModelRef, ToolState, UserMessageFile} from "./types.ts";

/** A tool invocation inside an assistant message's content array. */
export interface AssistantToolPart {
    type: "tool";
    id: string;
    name: string;
    executed?: boolean;
    state: ToolState;
    time?: {created?: number; ran?: number; completed?: number};
}

/** A streamed text block inside an assistant message's content array. */
export interface AssistantTextPart {
    type: "text";
    text: string;
}

/** A reasoning-model thinking block inside an assistant message. */
export interface AssistantReasoningPart {
    type: "reasoning";
    text: string;
}

export type AssistantPart = AssistantTextPart | AssistantReasoningPart | AssistantToolPart;

export interface ChatUserMessage {
    id: string;
    type: "user";
    text: string;
    files?: UserMessageFile[];
    /** Present when this message came from a slash-command submission:
     *  `text` carries the EXPANDED template the server stores (there is no
     *  server-side command metadata), while the transcript renders the
     *  compact `{name} {arguments}` form. Stamped client-side from the
     *  pending-command registry in messageStore.ts. */
    command?: {name: string; arguments: string};
    /** Stable React key across the optimistic→server id swap: send()
     *  appends a `local-*` bubble and the confirming enqueued event
     *  replaces its id (messageStore.ts carries this key onto the
     *  adopted message). Keying the transcript row by id would remount
     *  it and REPLAY the entrance animation — a double opacity
     *  animation under the transcript mask churns compositing layers,
     *  which flashes the whole conversation area on WebKitGTK (same
     *  class as FoldRow's transform-gpu note). */
    localKey?: string;
    /** LOCAL-ONLY flag (never on the wire): the optimistic bubble's POST
     *  FAILED (network/timeout — the mobile frp route's norm) and the
     *  bubble was kept as a FAILED row offering a retry instead of being
     *  silently dropped (the old behavior read as "my message vanished").
     *  Cleared implicitly: a retry drops the bubble and re-sends, and a
     *  server seed/page merge never carries the flag. */
    sendFailed?: boolean;
    time?: {created?: number};
}

export interface ChatAssistantMessage {
    id: string;
    type: "assistant";
    agent?: string;
    model?: SessionModelRef;
    content: AssistantPart[];
    finish?: string;
    cost?: number;
    tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: {read: number; write: number};
    };
    time?: {created?: number; completed?: number; streamed?: number};
    error?: unknown;
}

/** Turn separator emitted between assistant turns ("idle"/…). Not rendered. */
export interface ChatMarkerMessage {
    id: string;
    type: string; // "idle" | "system" | "synthetic" | "shell" | …
    time?: {created?: number};
    /** Present on shell-tool notifications: `{source: "shell", shellID,
     *  state, exit?}` marks the background command's completion. */
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
}

/** The server's persisted model-switch marker (one per `POST
 *  /api/session/{id}/model`, the switch's commit). The transcript renders
 *  it as one divider between the old and new model; `previous` is absent
 *  on the session's very first selection. Deliberately a type alias, not
 *  an interface: aliases satisfy `ChatMarkerMessage`'s implicit index
 *  signature, which is what the {@link isModelSwitched} predicate needs. */
export type ChatModelSwitchedMessage = {
    id: string;
    type: "model-switched";
    model: SessionModelRef;
    previous?: SessionModelRef;
    time?: {created?: number};
};

export type ChatMessage = ChatUserMessage | ChatAssistantMessage | ChatMarkerMessage;

/** A fresh id for optimistic local rows — collision-proofed with a
 *  random suffix (two sends inside one `Date.now()` millisecond would
 *  otherwise mint the SAME id, confusing the adoption swap). The `local-`
 *  prefix is load-bearing: it sorts before every server `msg_` id (the
 *  revert-boundary rule) and marks rows adoptable/droppable. */
export function nextLocalId(): string {
    return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Narrow a marker message to the persisted model-switch shape (see
 *  ChatModelSwitchedMessage). */
export function isModelSwitched(m: ChatMessage): m is ChatModelSwitchedMessage {
    return m.type === "model-switched";
}

export function isUserMessage(m: ChatMessage): m is ChatUserMessage {
    return m.type === "user";
}

export function isAssistantMessage(m: ChatMessage): m is ChatAssistantMessage {
    return m.type === "assistant";
}
