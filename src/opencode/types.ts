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

/** A pending permission request (`permission.asked` payload shape —
 *  verified against server v2.0.11: the event carries the v1 NAME with
 *  the v2 `action`/`resources` payload; the SDK's `permission.v2.asked`
 *  + `patterns` shapes never appear on the wire). */
export interface PermissionRequest {
    id: string; // "per_…"
    sessionID: string;
    /** What it wants to do: "external_directory" | "bash" | "edit" | … */
    action: string;
    /** What it wants to act on: paths, commands, URLs… */
    resources: string[];
    metadata?: Record<string, unknown>;
    /** Set when a tool call triggered the request. */
    source?: {type: "tool"; messageID: string; id: string};
}

/** The user's answer to a permission request. */
export type PermissionDecision = "once" | "always" | "reject";

/** One selectable choice of a form field. */
export interface FormFieldOption {
    value: string;
    label: string;
    description?: string;
}

/** One field of a form the server asks the user to fill. Union of the
 *  field kinds the real server's Form schema defines; the question tool
 *  only emits `string` (with options) and `multiselect` today — both
 *  with `custom: true` ("or type your own answer"). */
export type FormField = {
    key: string;
    title?: string;
    description?: string;
    required?: boolean;
    /** Visibility condition against another field's current value. */
    when?: {key: string; op: "eq" | "neq"; value: string | number | boolean}[];
} & (
    | {type: "string"; options?: FormFieldOption[]; placeholder?: string; default?: string; custom?: boolean}
    | {type: "multiselect"; options: FormFieldOption[]; custom?: boolean; default?: string[]}
    | {type: "boolean"; default?: boolean}
    | {type: "number" | "integer"; default?: number; minimum?: number; maximum?: number}
    | {type: "external"; url: string}
);

/** A pending form (`form.created` payload's `form` field). The question
 *  tool's forms carry `metadata.kind === "question"`. */
export interface FormRequest {
    id: string; // "frm_…"
    sessionID: string;
    title: string;
    metadata?: Record<string, unknown>;
    fields: FormField[];
}

/** A form answer: one value per field key. */
export type FormAnswer = Record<string, string | number | boolean | string[]>;

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
    /** v2.0.11 wire name for tool failure — the SDK/app previously
     *  listened for "session.tool.error", which this server never emits.
     *  Both are handled; payload shape is identical. */
    "session.tool.failed": {
        sessionID: string;
        assistantMessageID: string;
        id: string;
        error?: unknown;
        executed?: boolean;
    };
    /** v2.0.11 wire name for a failed step (e.g. the run was interrupted
     *  by dismissing a question) — no `session.step.ended` follows. */
    "session.step.failed": {
        sessionID: string;
        assistantMessageID: string;
        error?: {type?: string; message?: string};
        rawFinish?: string;
        cost?: number;
        tokens?: ChatAssistantMessage["tokens"];
    };
    /** The run stopped without succeeding/failing (dismissed question,
     *  stop button, shutdown). Clears the busy indicator. */
    "session.execution.interrupted": {sessionID: string; reason?: string};
    "session.usage.updated": {
        sessionID: string;
        cost?: number;
        tokens?: ChatAssistantMessage["tokens"];
    };
    /** Server v2.0.11 asks for approval over the permission system (the
     *  SDK's "permission.v2.asked" name is not what's on the wire). */
    "permission.asked": PermissionRequest;
    "permission.replied": {
        sessionID: string;
        requestID: string;
        reply: PermissionDecision;
    };
    /** The question tool surfaces as a form (there is no /api/question on
     *  this server generation — see api.ts). */
    "form.created": {form: FormRequest};
    "form.replied": {id: string; sessionID: string; answer?: FormAnswer};
    "form.cancelled": {id: string; sessionID: string};
}
