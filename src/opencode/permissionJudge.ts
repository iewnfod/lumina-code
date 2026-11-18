import type {PermissionModeId} from "./permissionModes.ts";
import type {ChatAssistantMessage, ChatMessage, PermissionRequest} from "./types.ts";
import {createModuleStore} from "../lib/moduleStore.ts";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * THE PERMISSION JUDGE (L2 of the AI permission evaluation) — the pure
 * planning half. The stateful runner lives in
 * hooks/usePermissionJudge.ts (mounted beside useSessionRequests in the
 * SessionDataProvider): when a `permission.asked` arrives, the gate here
 * decides whether a restricted helper session (agent
 * `lumina-permission-judge`, the user-selected model, deny-all
 * permissions, max_tokens 300 — see toolPluginConfig.ts's agent
 * definition) may decide it; an "allow" verdict replies `once` to every
 * grouped request, ANYTHING else (ask / timeout / unparseable / call
 * failure) falls back to the human card unchanged.
 *
 * Design constraints (spike-verified 2026-11, see plan.md):
 * - ONLY `external_directory` asks are judged (v1; shell commands are a
 *   deliberate later step) and ONLY in balanced mode — a strict user
 *   chose "ask me for everything" and must not be second-guessed.
 * - HARD_PROTECTED paths never reach the model at all — no verdict can
 *   allow them, which keeps prompt injection (the judged context
 *   includes conversation text) from ever unlocking credentials.
 * - Auto-allows are ALWAYS `once` — the judge never writes a durable
 *   rule; repeated identical asks ride the short-lived signature cache
 *   instead.
 *
 * node-testable (permissionJudge.test.ts).
 */

/** The ask shapes we judge. Wire-verified: external accesses assert
 *  action "external_directory" with resources ["<dirname>/*"]; shell
 *  commands assert action "shell" (observed live) with the command
 *  string(s) as resources. */
export const JUDGED_ACTIONS: readonly string[] = ["external_directory", "shell"];

/**
 * Shell commands the judge may NEVER auto-allow — destructive,
 * privilege-elevating or disk-level operations whose misjudged cost is
 * unrecoverable. Matched against the command text (resources + the
 * triggering tool call's input). Over-matching only degrades to "ask"
 * — being over-protective here is free. Anything NOT matching is still
 * subject to the model's verdict (which has its own command guidance
 * in the agent system prompt).
 */
const DANGEROUS_COMMAND_MATCHERS: readonly RegExp[] = [
    /\bsudo\b/u,
    /\bsu\b(?=[\s$])/u,
    /\bshutdown\b/u,
    /\breboot\b/u,
    /\bpoweroff\b/u,
    /\bsystemctl\b/u,
    /\bmkfs\b/u,
    /\bfdisk\b/u,
    /\bparted\b/u,
    /\bwipefs\b/u,
    /\bdd\b/u,
    /\bmount\b/u,
    /\bumount\b/u,
    /\bchmod\b[^|;&]*\s-R/u,
    /\bchown\b[^|;&]*\s-R/u,
    /\brm\s[^|;&]*-[a-z]*r[a-z]*f/u,
    /\brm\s[^|;&]*-[a-z]*f[a-z]*r/u,
    /\/dev\/(?:sd|nvme|vd|mmcblk)/u,
    /(?:curl|wget)[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|fi)?sh\b/u,
];

/** How long an allow/ask verdict is remembered per signature — one
 *  session run typically re-asserts the same external directory on
 *  every file inside it (the server asserts per tool invocation with
 *  no dedup), so the cache collapses N asks into ONE model call. */
export const JUDGE_VERDICT_TTL_MS = 5 * 60 * 1000;

/** The model call's hard ceiling (the runner interrupts the helper
 *  session past it and falls back to the human card). */
export const JUDGE_TIMEOUT_MS = 10_000;

/** Max judge calls in flight — bursts of distinct external dirs queue
 *  instead of fanning out (cost + provider rate limits). */
export const JUDGE_MAX_CONCURRENT = 2;

// --- Module stores (the SILENT-HOLD contract) ---------------------------------
//
// While a judgment runs, the ask is INVISIBLE: the request card, the
// sidebar badge and the desktop notification all suppress it (the
// card never mounts; useSessionRequests' pendingCounts filters held
// ids — which also means the notification's 0→N transition fires only
// when the judge RELEASES the ask back to the human, never during the
// silent wait). Release happens on every exit path: allow (the
// permission.replied handler), ask/timeout/failure (the runner's
// finally). The 10s JUDGE_TIMEOUT_MS bounds the silent window.

const heldStore = createModuleStore<ReadonlySet<string>>(new Set());

/** Belt-and-braces auto-release timers — nothing may stay suppressed
 *  forever (a lost replied event, a dropped SSE stream would otherwise
 *  hide an ask no one can answer). Past the judge's own ceiling the
 *  hold lifts by itself. */
const heldTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Hold an ask invisibly while it is being judged. */
export function markHeld(requestId: string): void {
    const prev = heldStore.get();
    if (!prev.has(requestId)) {
        const next = new Set(prev);
        next.add(requestId);
        heldStore.set(next);
    }
    if (!heldTimers.has(requestId)) {
        const timer = setTimeout(() => {
            heldTimers.delete(requestId);
            releaseHeld(requestId);
        }, JUDGE_TIMEOUT_MS + 5_000);
        heldTimers.set(requestId, timer);
    }
}

/** Release the hold — the ask becomes user-visible again (unless the
 *  reply already settled it). Idempotent. */
export function releaseHeld(requestId: string): void {
    const timer = heldTimers.get(requestId);
    if (timer) {
        clearTimeout(timer);
        heldTimers.delete(requestId);
    }
    const prev = heldStore.get();
    if (!prev.has(requestId)) return;
    const next = new Set(prev);
    next.delete(requestId);
    heldStore.set(next);
}

export function subscribeHeld(listener: () => void): () => void {
    return heldStore.subscribe(listener);
}

export function peekHeld(): ReadonlySet<string> {
    return heldStore.get();
}

/** One auto-allow audit entry — the quiet "已自动放行" line above the
 *  composer shows the newest one for a few seconds; the durable,
 *  queryable history (the AI 权限评估 settings page) carries the rest.
 *  PERSISTED (survives restarts): auditing what the AI allowed is only
 *  useful if the record outlives the session that saw it. */
export interface JudgeAuditEntry {
    requestId: string;
    sessionID: string;
    action: string;
    resources: string[];
    reason: string;
    time: number;
}

const AUDIT_LIMIT = 50;

function isSaneEntry(v: unknown): v is JudgeAuditEntry {
    if (typeof v !== "object" || v === null) return false;
    const e = v as Record<string, unknown>;
    return typeof e["requestId"] === "string" && typeof e["sessionID"] === "string" &&
        typeof e["action"] === "string" && Array.isArray(e["resources"]) &&
        typeof e["reason"] === "string" && typeof e["time"] === "number";
}

const auditStore = createPersistedStore<readonly JudgeAuditEntry[]>({
    key: "lumina-code:judge-audit",
    label: "permission judge audit log",
    read: (raw) => {
        if (raw === null) return [];
        try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter(isSaneEntry) : [];
        } catch {
            return [];
        }
    },
    // Absence = no history yet (a fresh install's storage stays clean).
    write: (value) => (value.length === 0 ? null : JSON.stringify(value.slice(0, AUDIT_LIMIT))),
    eq: (a, b) => a === b,
});

export function pushAudit(entry: JudgeAuditEntry): void {
    const next = [entry, ...auditStore.get()].slice(0, AUDIT_LIMIT);
    auditStore.set(next);
}

export function subscribeAudit(listener: () => void): () => void {
    return auditStore.subscribe(listener);
}

export function peekAudit(): readonly JudgeAuditEntry[] {
    return auditStore.get();
}

// --- Hard-protected paths ----------------------------------------------------

/**
 * Paths the judge may NEVER allow, regardless of the model's verdict —
 * credentials, keys and account configuration. Matched against every
 * resource AND the triggering tool call's input text (the resource is
 * the directory pattern; the exact file only appears in the tool
 * input). Segment-bounded so `foo.ssh.bar` style names don't
 * false-positive; `.env` matches as a file basename/extension (the
 * built-in policy already asks for project .env reads — this covers
 * the EXTERNAL spellings the base ask can't catch).
 */
const HARD_PROTECTED_MATCHERS: readonly RegExp[] = [
    /\/\.ssh\//u,
    /\/\.aws\//u,
    /\/\.gnupg\//u,
    /\/\.config\/gh\//u,
    /\/\.config\/gcloud\//u,
    /\/\.docker\//u,
    /\/\.kube\//u,
    /\/\.netrc(?:\/|$)/u,
    /\.env(?![\w-])/u,
    /id_rsa|id_ed25519|authorized_keys|known_hosts/u,
];

/** Whether ANY of the texts (resources, tool input) touches a
 *  hard-protected path. False positives only degrade to "ask" — being
 *  over-protective here is free. */
export function isHardProtected(...texts: string[]): boolean {
    const joined = texts.filter(Boolean).join("\n");
    return HARD_PROTECTED_MATCHERS.some((re) => re.test(joined));
}

/** Whether ANY of the texts is a DANGEROUS shell command (see
 *  DANGEROUS_COMMAND_MATCHERS) — such commands never reach the judge
 *  model at all; the human card shows immediately. */
export function isDangerousCommand(...texts: string[]): boolean {
    const joined = texts.filter(Boolean).join("\n");
    return DANGEROUS_COMMAND_MATCHERS.some((re) => re.test(joined));
}

// --- Signature + verdict cache ------------------------------------------------

/** Group key — deliberately the same composition as permissionGroups.ts
 *  (identical asks share a card; they share a verdict too). */
export function signatureOf(request: Pick<PermissionRequest, "action" | "resources">): string {
    return request.action + "\u0000" + request.resources.join("\u0001");
}

export interface JudgeVerdict {
    verdict: "allow" | "ask";
    reason: string;
}

export type VerdictCache = Map<string, JudgeVerdict & {expiresAt: number}>;

export function cacheGet(cache: VerdictCache, signature: string, now: number): JudgeVerdict | null {
    const hit = cache.get(signature);
    if (!hit) return null;
    if (hit.expiresAt <= now) {
        cache.delete(signature);
        return null;
    }
    return {verdict: hit.verdict, reason: hit.reason};
}

export function cachePut(
    cache: VerdictCache,
    signature: string,
    verdict: JudgeVerdict,
    now: number,
): void {
    cache.set(signature, {...verdict, expiresAt: now + JUDGE_VERDICT_TTL_MS});
}

// --- The gate ----------------------------------------------------------------

/** What the triggering tool call looked like (resolved by the RUNNER
 *  from the ask's `source` part in the message store; null when the
 *  part can't be found — the judge then decides on action+resources
 *  alone). `inputText` is the tool's input object serialized compactly
 *  (already truncated by the runner). */
export interface JudgeToolCall {
    name: string;
    inputText: string;
}

export interface JudgeGateEnv {
    /** A judge model is configured (the Tools tab switch is on). */
    enabled: boolean;
    /** The asking session's directory's permission mode; null while
     *  unknown — unknown never judges (conservative). */
    sessionMode: PermissionModeId | null;
    cache: VerdictCache;
    now: number;
}

export type JudgeGate =
    | {judge: false; reason: "disabled" | "action" | "mode" | "hard-protected" | "dangerous-command"}
    /** judge: true — `cached` carries a remembered verdict when one
     *  exists (allow → the runner may reply immediately, no model call;
     *  ask → skip the call and show the card). */
    | {judge: true; cached: JudgeVerdict | null};

/** The mode-independent subset of the gate — everything checkable
 *  SYNCHRONOUSLY before the (async) directory-mode read: enabled,
 *  action shape, hard protection, verdict cache. The runner calls this
 *  first so an ask it will never judge costs no fs/read at all. */
export type CheapGate =
    | {proceed: false; reason: "disabled" | "action" | "hard-protected" | "dangerous-command"}
    | {proceed: true; cached: JudgeVerdict | null};

export function cheapGate(
    request: Pick<PermissionRequest, "action" | "resources">,
    toolCall: JudgeToolCall | null,
    enabled: boolean,
    cache: VerdictCache,
    now: number,
): CheapGate {
    if (!enabled) return {proceed: false, reason: "disabled"};
    if (!JUDGED_ACTIONS.includes(request.action)) return {proceed: false, reason: "action"};
    if (isHardProtected(...request.resources, toolCall?.inputText ?? "")) {
        return {proceed: false, reason: "hard-protected"};
    }
    // Shell commands additionally never reach the model when they match
    // the destructive-pattern table — the human decides those.
    if (request.action === "shell" &&
        isDangerousCommand(...request.resources, toolCall?.inputText ?? "")) {
        return {proceed: false, reason: "dangerous-command"};
    }
    return {proceed: true, cached: cacheGet(cache, signatureOf(request), now)};
}

export function shouldJudge(
    request: Pick<PermissionRequest, "action" | "resources">,
    toolCall: JudgeToolCall | null,
    env: JudgeGateEnv,
): JudgeGate {
    // strict = the user asked to be asked for everything; full asks
    // almost nothing. Only balanced's asks are judgment material.
    if (env.sessionMode !== "balanced") return {judge: false, reason: "mode"};
    const cheap = cheapGate(request, toolCall, env.enabled, env.cache, env.now);
    return cheap.proceed ? {judge: true, cached: cheap.cached} : {judge: false, reason: cheap.reason};
}

// --- Prompt + verdict parsing ---------------------------------------------------

/** Clamp helper — keep the judged context tiny (the whole point of the
 *  token budget: input < ~500 tokens). */
function clamp(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/** The one-shot judgment prompt. Plain compact text — the JSON contract
 *  lives in the AGENT's system prompt (toolPluginConfig.ts); this only
 *  carries the case file. Shell asks label the resources as the command
 *  line (their natural spelling on the wire). */
export function buildJudgePrompt(
    request: Pick<PermissionRequest, "action" | "resources">,
    toolCall: JudgeToolCall | null,
    lastUserText: string | null,
): string {
    const targetLabel = request.action === "shell" ? "command" : "target";
    const lines = [
        `action: ${request.action}`,
        `${targetLabel}: ${clamp(request.resources.join(", "), 300)}`,
    ];
    if (toolCall) {
        lines.push(`tool call: ${toolCall.name} ${clamp(toolCall.inputText, 200)}`);
    }
    if (lastUserText) {
        lines.push(`user's latest message: ${clamp(lastUserText, 300)}`);
    }
    return `Permission request to evaluate:\n${lines.join("\n")}`;
}

/**
 * Parse the judge model's reply. Lenient by design — the model was told
 * to answer with one minified JSON object, but the wire has no
 * structured-output guarantee (v2.0.11): extract the first flat
 * `{...}` span and validate. ANYTHING else (fence-wrapped with text,
 * prose, truncation, wrong types) reads as null = "ask" — the fail-safe
 * that makes a misbehaving judge model harmless.
 */
export function parseVerdict(reply: string): JudgeVerdict | null {
    const match = reply.match(/\{[^{}]*\}/u);
    if (!match) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(match[0]);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const {decision, reason} = parsed as {decision?: unknown; reason?: unknown};
    if (decision !== "allow" && decision !== "ask") return null;
    return {verdict: decision, reason: typeof reason === "string" ? reason.slice(0, 200) : ""};
}

/** "providerID/modelID" (the compact form the plugin options store) →
 *  the create-body model ref. Mirrors the plugin's parseModelRef. */
export function parseModelRef(model: string): {providerID: string; modelID: string} | null {
    const sep = model.indexOf("/");
    if (sep <= 0 || sep >= model.length - 1) return null;
    return {providerID: model.slice(0, sep), modelID: model.slice(sep + 1)};
}

// --- Judge context resolution ---------------------------------------------------

/** The directory whose permission LADDER governs an ask from a session
 *  — the same mapping usePermissionsPanel's usePermissionDirectory
 *  makes for the PICKER: DAILY sessions live in
 *  `<workspace>/Sessions/<name>/` folders that carry no config of their
 *  own (reading them directly would answer "virtual strict" and
 *  silently disable the judge), so when the session's directory sits
 *  directly under a `Sessions` container (defaultWorkspace.ts's
 *  layout), the WORKSPACE root two levels up owns the ladder. Anything
 *  else (dev projects, root-level daily sessions, unexpected layouts)
 *  returns the directory unchanged. node-testable. */
export function ladderDirectoryOf(directory: string, sessionMode: unknown): string {
    if (sessionMode !== "daily") return directory;
    const parts = directory.replace(/\/+$/, "").split("/");
    if (parts.length < 3 || parts[parts.length - 2] !== "Sessions") return directory;
    return parts.slice(0, -2).join("/");
}

/** ChatMessage's marker arm carries a WIDE `type: string`, so a
 *  `m.type === "assistant"` comparison alone cannot narrow the union —
 *  this guard checks the content array too. */
function isAssistantMessage(m: ChatMessage): m is ChatAssistantMessage {
    return m.type === "assistant" && Array.isArray((m as {content?: unknown}).content);
}

/** The reply text of a finished judge session — newest assistant
 *  message's text parts joined (the helper is single-turn, so the
 *  first assistant hit from the end IS the verdict). Exported for the
 *  runner; node-testable. */
export function assistantReplyText(messages: readonly ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (!isAssistantMessage(m)) continue;
        const text = m.content
            .filter((p): p is {type: "text"; text: string} => p.type === "text")
            .map((p) => p.text)
            .join("\n")
            .trim();
        if (text) return text;
    }
    return "";
}

/** Pull the two intent signals out of the asking session's transcript:
 *  the triggering tool call (the ask's `source` part — its NAME is what
 *  separates a read from an edit; the resource alone is only the
 *  directory) and the user's latest message (the intent the verdict
 *  must be consistent with). Both null when absent — the judge then
 *  decides on action+resources alone, which biases toward "ask".
 *  node-testable. */
export function resolveJudgeContext(
    messages: readonly ChatMessage[],
    source: PermissionRequest["source"],
): {toolCall: JudgeToolCall | null; lastUserText: string | null} {
    let toolCall: JudgeToolCall | null = null;
    let lastUserText: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (!isAssistantMessage(m) && m.type !== "user") continue;
        if (!toolCall && isAssistantMessage(m) && source && m.id === source.messageID) {
            const part = m.content.find((p) => p.type === "tool" && p.id === source.id);
            if (part && part.type === "tool") {
                let inputText = "";
                try {
                    inputText = JSON.stringify(part.state?.input ?? {}) ?? "";
                } catch {
                    inputText = "";
                }
                toolCall = {name: part.name, inputText};
            }
        }
        if (!lastUserText && m.type === "user" && typeof m.text === "string" && m.text.trim()) {
            lastUserText = m.text;
        }
        if (toolCall && lastUserText) break;
    }
    return {toolCall, lastUserText};
}
