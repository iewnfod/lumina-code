/**
 * OpenCode wire types — hand-defined from live observation of server v2.0.x
 * (the npm SDK's generated types drift from the installed server; these are
 * the shapes actually on the wire, kept loose where the server is loose).
 */

export interface SessionTime {
    created: number;
    updated: number;
}

export interface SessionModelRef {
    id: string;
    providerID: string;
    variant?: string;
}

/** One thinking-depth variant of a model ("none" | "low" | "high" | "max" | …). */
export interface ModelVariant {
    id: string;
}

/** `GET /api/agent` entry — the selectable "modes" (build/plan/…). */
export interface OpencodeAgent {
    id: string;
    name?: string;
    description?: string;
    /** "primary" modes are user-selectable; "subagent" ones are internal. */
    mode: "primary" | "subagent" | string;
    hidden?: boolean;
}

/** `GET /api/provider` entry — an active model provider. */
export interface OpencodeProvider {
    id: string;
    name?: string;
    /** "auto" (activated by credentials) | "enabled" (always on). */
    activation?: string;
    settings?: {apiKey?: string; [key: string]: unknown};
}

/** `GET /api/model` entry. */
export interface OpencodeModel {
    id: string;
    modelID: string;
    providerID: string;
    name?: string;
    family?: string;
    variants?: ModelVariant[];
    capabilities?: {
        tools?: boolean;
        input?: string[];
        output?: string[];
    };
    status?: string;
    enabled?: boolean;
    limit?: {context?: number; output?: number};
    released?: number;
}

/** `GET /api/project` entry — a known working directory. */
export interface OpencodeProject {
    id: string;
    canonical: string;
    vcs?: string;
    time?: {created?: number; updated?: number};
}

/** An attachment staged in the composer (data-URI form). */
export interface ComposerAttachment {
    id: string;
    name: string;
    mime: string;
    size: number;
    /** data:… URI — posted as the prompt's `files[].uri`. */
    uri: string;
}

/** A file attachment as it rides on a user message (server-normalized). */
export interface UserMessageFile {
    name?: string;
    mime?: string;
    /** Bare base64 (no data: prefix) when the server inlined the content. */
    data?: string;
    [key: string]: unknown;
}

export interface OpencodeSession {
    id: string;
    /** Auto-generated until the server retitles (session.renamed). */
    title?: string;
    projectID: string;
    /** Set on subagent-spawned child sessions; roots (user-initiated) have none. */
    parentID?: string;
    directory?: string;
    location?: {directory?: string; workspace?: string};
    agent?: string;
    model?: SessionModelRef;
    time?: SessionTime;
    cost?: number;
    tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: {read: number; write: number};
    };
}

/** One text piece of a tool result (`content: [{type:"text", text}]`). */
export interface ToolContentPiece {
    type: string;
    text: string;
}

export interface ToolState {
    status: "pending" | "running" | "completed" | "error";
    input?: unknown;
    content?: ToolContentPiece[];
    metadata?: Record<string, unknown>;
    error?: unknown;
}

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
    type: string; // "idle" | "system" | "synthetic" | …
    time?: {created?: number};
    [key: string]: unknown;
}

export type ChatMessage = ChatUserMessage | ChatAssistantMessage | ChatMarkerMessage;

export function isUserMessage(m: ChatMessage): m is ChatUserMessage {
    return m.type === "user";
}

export function isAssistantMessage(m: ChatMessage): m is ChatAssistantMessage {
    return m.type === "assistant";
}

/**
 * Payload shapes of the live `/api/event` frames we consume (payload under
 * `data`). Only the fields the UI reads are declared.
 */
export interface EventMap {
    "session.created": {sessionID: string};
    "session.updated": {sessionID: string};
    "session.deleted": {sessionID: string};
    "session.renamed": {sessionID: string; title: string};
    "session.inbox.enqueued": {
        sessionID: string;
        inboxID: string;
        item: {type: string; payload?: {text?: string; files?: UserMessageFile[]}};
    };
    "session.execution.started": {sessionID: string};
    "session.execution.succeeded": {sessionID: string};
    "session.execution.failed": {sessionID: string};
    "session.step.started": {
        sessionID: string;
        assistantMessageID: string;
        agent: string;
        model: SessionModelRef;
        started?: number;
    };
    "session.step.ended": {
        sessionID: string;
        assistantMessageID: string;
        finish?: string;
    };
    "session.text.started": {sessionID: string; assistantMessageID: string; ordinal: number};
    "session.text.delta": {sessionID: string; assistantMessageID: string; ordinal: number; delta: string};
    "session.text.ended": {sessionID: string; assistantMessageID: string; ordinal: number; text: string};
    "session.reasoning.started": {sessionID: string; assistantMessageID: string; ordinal: number};
    "session.reasoning.delta": {sessionID: string; assistantMessageID: string; ordinal: number; delta: string};
    "session.reasoning.ended": {sessionID: string; assistantMessageID: string; ordinal: number; text: string};
    "session.tool.input.started": {sessionID: string; assistantMessageID: string; id: string; name: string};
    "session.tool.input.ended": {sessionID: string; assistantMessageID: string; id: string; text: string};
    "session.tool.called": {sessionID: string; assistantMessageID: string; id: string; input?: unknown};
    "session.tool.progress": {sessionID: string; assistantMessageID: string; id: string};
    "session.tool.success": {
        sessionID: string;
        assistantMessageID: string;
        id: string;
        content?: ToolContentPiece[];
        metadata?: Record<string, unknown>;
    };
    "session.tool.error": {
        sessionID: string;
        assistantMessageID: string;
        id: string;
        error?: unknown;
    };
    "session.usage.updated": {
        sessionID: string;
        cost?: number;
        tokens?: ChatAssistantMessage["tokens"];
    };
}
