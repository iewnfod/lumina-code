import {
    BadgeCheck,
    ClipboardCheck,
    ClipboardList,
    FilePen,
    FilePlus,
    FolderOpen,
    FolderSearch,
    Globe,
    ListChecks,
    ListTodo,
    MessageCircleQuestion,
    ScanEye,
    Search,
    Sparkles,
    SquareCheck,
    SquareTerminal,
    Wrench,
    type LucideIcon,
} from "lucide-react";
import type {AssistantToolPart} from "../../opencode/types.ts";
import type {TranslationKey} from "../../hooks/i18n.tsx";

/** Shared error accent for failed tools and failed model steps alike.
 *  The value is a CSS var reference (resolves in the inline styles of its
 *  consumers) pointing at the --color-danger-text token in main.css. */
export const ERROR_TEXT = "var(--color-danger-text)";

/**
 * Tool-call display metadata (pure) — the name→{title, icon} table and
 * the small input-shape helpers ToolCard's detail/accent lines read.
 * Extracted so the mapping is node-testable and shared (ActivityGroup's
 * summary line also resolves names through here).
 */

/** Human title (as a translation key) + icon per known tool; falls back
 *  to a capitalized wrench.
 *
 *  `markdown: true` marks tools whose OUTPUT is markdown BY SPEC — the
 *  expanded body renders through the Markdown component instead of the
 *  plain mono pre-wrap. Verified against the server's tool definitions:
 *  webfetch returns the fetched page "as text, markdown, or HTML" with
 *  markdown the DEFAULT format; websearch returns the provider's
 *  context string "optimized for LLMs" (markdown with links); vision
 *  (lumina-tools plugin) returns the vision model's ANSWER — a model
 *  response. Everything else (bash, read, grep, …) is verbatim plain
 *  text and must NOT be markdown-rendered — syntax would be mangled. */
export const TOOL_META: Record<string, {title: TranslationKey; icon: LucideIcon; markdown?: true}> = {
    bash: {title: "Shell", icon: SquareTerminal},
    shell: {title: "Shell", icon: SquareTerminal},
    power_shell: {title: "Shell", icon: SquareTerminal},
    edit: {title: "Edit", icon: FilePen},
    apply_patch: {title: "Edit", icon: FilePen},
    patch: {title: "Edit", icon: FilePen},
    write: {title: "Write", icon: FilePlus},
    read: {title: "Read", icon: FolderOpen},
    grep: {title: "Grep", icon: Search},
    glob: {title: "Glob", icon: FolderSearch},
    list: {title: "List", icon: FolderSearch},
    todowrite: {title: "Todo", icon: ListTodo},
    todoread: {title: "Todo", icon: ListTodo},
    webfetch: {title: "Fetch", icon: Globe, markdown: true},
    websearch: {title: "Search", icon: Globe, markdown: true},
    // The question tool — the "AI asks the user" surface. Distinct from the
    // generic wrench so its FoldRow reads as a question, not a tool call.
    question: {title: "Question", icon: MessageCircleQuestion},
    skill: {title: "Skill", icon: Sparkles},
    // Lumina Code's tools plugin (see src/plugins/luminaTools.js): image
    // inspection via a vision-capable helper model, and the model
    // switching the session into Plan Mode on its own initiative.
    vision: {title: "Vision", icon: ScanEye, markdown: true},
    plan_mode: {title: "Plan mode", icon: ClipboardList},
    // The plan workflow (same plugin): plan submission for approval,
    // in-order task completion reports, remaining-list amendments, and
    // the completion report the user accepts before archival.
    plan_submit: {title: "Plan submission", icon: ClipboardCheck},
    task_complete: {title: "Task complete", icon: SquareCheck},
    plan_amend: {title: "Plan amend", icon: ListChecks},
    work_submit: {title: "Work submission", icon: BadgeCheck},
};

/** Display title for a tool name (used by ActivityGroup's summary too).
 *  Known tools resolve through the active language's dictionary; the
 *  capitalized fallback for unknown tools is the raw name and stays
 *  untranslated (it's a proper noun, not copy). */
export function toolDisplayName(name: string, t: Record<TranslationKey, string>): string {
    const meta = TOOL_META[name];
    return meta ? t[meta.title] : name.charAt(0).toUpperCase() + name.slice(1);
}

/** Whether a tool's expanded OUTPUT should render as markdown (see
 *  TOOL_META's `markdown` flag for the verified per-tool rationale). */
export function toolOutputIsMarkdown(name: string): boolean {
    return TOOL_META[name]?.markdown === true;
}

/** Resolved {title, icon} for a tool row (wrench fallback for unknown). */
export function metaFor(name: string, t: Record<TranslationKey, string>): {title: string; icon: LucideIcon} {
    const meta = TOOL_META[name];
    return meta ? {title: t[meta.title], icon: meta.icon} : {title: toolDisplayName(name, t), icon: Wrench};
}

/** The tool call's input as an object, when it is one. */
export function inputObject(part: AssistantToolPart): Record<string, unknown> | null {
    const input = part.state.input;
    if (input === undefined || input === null) return null;
    if (typeof input !== "object") return null;
    return input as Record<string, unknown>;
}

/** First present, non-empty string among the given keys. */
export function inputStr(o: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const v = o[key];
        if (typeof v === "string" && v) return v;
    }
    return undefined;
}

/** The input's file path when the tool names one (write/edit/read send
 *  `filePath`, list/grep send `path`) — drives the diff view's language
 *  detection. Undefined for tools without a file input. */
export function inputFilePath(part: AssistantToolPart): string | undefined {
    const o = inputObject(part);
    return o ? inputStr(o, "filePath", "file_path", "path") : undefined;
}

/** Human text of a tool error payload — `{type, message}` objects carry
 *  the reason ("The user dismissed this question", …). */
export function errorText(error: unknown): string | null {
    if (error == null) return null;
    if (typeof error === "object" && error !== null && "message" in error) {
        const msg = (error as {message?: unknown}).message;
        if (typeof msg === "string" && msg) return msg;
    }
    const s = String(error);
    return s && s !== "[object Object]" ? s : null;
}
