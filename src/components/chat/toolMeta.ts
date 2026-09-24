import {
    FilePen,
    FilePlus,
    FolderOpen,
    FolderSearch,
    Globe,
    ListTodo,
    MessageCircleQuestion,
    ScanEye,
    Search,
    Sparkles,
    SquareTerminal,
    Wrench,
    type LucideIcon,
} from "lucide-react";
import type {AssistantToolPart} from "../../opencode/types.ts";
import type {TranslationKey} from "../../hooks/i18n.tsx";

/** Shared error accent for failed tools and failed model steps alike. */
export const ERROR_TEXT = "#f87171";

/**
 * Tool-call display metadata (pure) — the name→{title, icon} table and
 * the small input-shape helpers ToolCard's detail/accent lines read.
 * Extracted so the mapping is node-testable and shared (ActivityGroup's
 * summary line also resolves names through here).
 */

/** Human title (as a translation key) + icon per known tool; falls back
 *  to a capitalized wrench. */
export const TOOL_META: Record<string, {title: TranslationKey; icon: LucideIcon}> = {
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
    webfetch: {title: "Fetch", icon: Globe},
    websearch: {title: "Search", icon: Globe},
    // The question tool — the "AI asks the user" surface. Distinct from the
    // generic wrench so its FoldRow reads as a question, not a tool call.
    question: {title: "Question", icon: MessageCircleQuestion},
    skill: {title: "Skill", icon: Sparkles},
    // Lumina Code's tools plugin: image inspection via a vision-capable
    // helper model (see src/plugins/luminaTools.js).
    vision: {title: "Vision", icon: ScanEye},
};

/** Display title for a tool name (used by ActivityGroup's summary too).
 *  Known tools resolve through the active language's dictionary; the
 *  capitalized fallback for unknown tools is the raw name and stays
 *  untranslated (it's a proper noun, not copy). */
export function toolDisplayName(name: string, t: Record<TranslationKey, string>): string {
    const meta = TOOL_META[name];
    return meta ? t[meta.title] : name.charAt(0).toUpperCase() + name.slice(1);
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
