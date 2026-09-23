import type {AssistantToolPart} from "../../opencode/types.ts";
import {inputObject, inputStr} from "./toolMeta.ts";

/**
 * Git-diff-style line model for file-mutating tool calls (edit /
 * apply_patch / write), computed PURELY from the tool input stored in
 * the part — the server never persists the pre-edit file content with
 * the part, so a real `git diff` is impossible for historical messages
 * (and would lie about them once later edits land). edit diffs its
 * oldString vs newString with a line LCS — unchanged lines survive as
 * dim context, like git's hunk context, so replacing a whole function
 * with a one-line change doesn't paint the block solid red/green.
 * write shows its whole content as added (there is no old text to
 * diff against); apply_patch colors its patchText by line prefix.
 *
 * Pure: no React — node-testable (toolDiff.test.ts).
 */

export interface DiffLine {
    kind: "add" | "del" | "same";
    text: string;
}

/** LCS table cell cap; beyond it the changed middle renders as a whole
 * removal + whole addition instead of an O(n·m) table. */
/** Diff red/green — shared by every diff surface (tool cards, the stats
 *  panel's file diff view); ToolCard's DiffCounts reads the same pair. */
export const DIFF_ADD = "#22c55e";
export const DIFF_DEL = "#ef4444";

const MAX_LCS_CELLS = 1_000_000;

/** Split into display lines, dropping the single empty segment a
 * trailing newline produces ("a\nb\n" → ["a","b"], not […,""]). */
function toLines(text: string): string[] {
    if (text === "") return [];
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
}

/** Line-level diff: common prefix/suffix stay as context lines, the
 * changed middle goes through a longest-common-subsequence walk
 * (del before add, like git). */
export function diffLines(oldText: string, newText: string): DiffLine[] {
    const a = toLines(oldText);
    const b = toLines(newText);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    const out: DiffLine[] = [];
    for (let i = 0; i < start; i++) out.push({kind: "same", text: a[i]});
    if (midA.length * midB.length > MAX_LCS_CELLS) {
        for (const text of midA) out.push({kind: "del", text});
        for (const text of midB) out.push({kind: "add", text});
    } else {
        // dp[i][j] = LCS length of midA[i:] vs midB[j:], filled from the
        // bottom-right. Flat row-major Int32Array of (m+1)·(n+1) cells.
        const m = midA.length;
        const n = midB.length;
        const dp = new Int32Array((m + 1) * (n + 1));
        for (let i = m - 1; i >= 0; i--) {
            for (let j = n - 1; j >= 0; j--) {
                dp[i * (n + 1) + j] = midA[i] === midB[j]
                    ? dp[(i + 1) * (n + 1) + j + 1] + 1
                    : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < m && j < n) {
            if (midA[i] === midB[j]) {
                out.push({kind: "same", text: midA[i]});
                i++;
                j++;
            } else if (dp[(i + 1) * (n + 1) + j] >= dp[i * (n + 1) + j + 1]) {
                out.push({kind: "del", text: midA[i]});
                i++;
            } else {
                out.push({kind: "add", text: midB[j]});
                j++;
            }
        }
        for (; i < m; i++) out.push({kind: "del", text: midA[i]});
        for (; j < n; j++) out.push({kind: "add", text: midB[j]});
    }
    for (let i = endA; i < a.length; i++) out.push({kind: "same", text: a[i]});
    return out;
}

/** apply_patch's patchText → colored lines by their diff prefix; file
 * headers (+++/---) and hunk markers (@@) read as context. */
export function patchLines(patchText: string): DiffLine[] {
    return toLines(patchText).map((raw) => {
        if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("@@")) {
            return {kind: "same", text: raw};
        }
        if (raw.startsWith("+")) return {kind: "add", text: raw.slice(1)};
        if (raw.startsWith("-")) return {kind: "del", text: raw.slice(1)};
        // Context lines carry a single leading space in patch format.
        return {kind: "same", text: raw.startsWith(" ") ? raw.slice(1) : raw};
    });
}

function hasChanges(lines: DiffLine[]): boolean {
    return lines.some((line) => line.kind !== "same");
}

/**
 * The diff view for a tool part's stored input, or null when the tool
 * doesn't mutate files or its input carries nothing diffable (older
 * parts, malformed input) — callers fall back to the raw output view.
 */
export function toolDiffFor(part: AssistantToolPart): DiffLine[] | null {
    const o = inputObject(part);
    if (!o) return null;
    switch (part.name) {
        case "edit":
        case "apply_patch": {
            const patch = inputStr(o, "patchText", "patch_text");
            if (patch) {
                const lines = patchLines(patch);
                return hasChanges(lines) ? lines : null;
            }
            const oldText = inputStr(o, "oldString", "old_string");
            const newText = inputStr(o, "newString", "new_string");
            if (oldText === undefined && newText === undefined) return null;
            const lines = diffLines(oldText ?? "", newText ?? "");
            return hasChanges(lines) ? lines : null;
        }
        case "write": {
            const content = inputStr(o, "content");
            if (content === undefined) return null;
            return toLines(content).map((text) => ({kind: "add" as const, text}));
        }
        default:
            return null;
    }
}

/** "+N −N" counts for the row's accent slot — changed lines only, so
 * the header counts always match what the expanded diff shows. */
export function diffCounts(lines: DiffLine[]): {added?: number; removed?: number} {
    let added = 0;
    let removed = 0;
    for (const line of lines) {
        if (line.kind === "add") added++;
        else if (line.kind === "del") removed++;
    }
    return {added: added || undefined, removed: removed || undefined};
}
