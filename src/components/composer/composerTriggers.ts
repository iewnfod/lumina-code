import {$getSelection, $isRangeSelection, $isTextNode, type LexicalEditor, type LexicalNode} from "lexical";
import {$isCommandMentionNode, type CommandMentionNode} from "./CommandMentionNode.tsx";
import {$isFileMentionNode, type FileMentionNode} from "./FileMentionNode.tsx";

/**
 * Composer trigger detection + mention navigation — everything that works
 * on the Lexical node tree to decide what the `/` and `@` autocompletes
 * are doing. Extracted from ChatInput.tsx so the editor component reads
 * as wiring, not algorithms.
 */

/** What the composer is autocompleting right now: the trigger character's
 *  kind plus WHERE it lives in the editor tree — the text node holding it
 *  and the character offset inside that node — and the query typed since.
 *  Anchoring to the node (not a serialized-string offset) keeps detection
 *  and replacement stable while the rest of the text mutates. */
export interface TriggerState {
    kind: "command" | "file";
    /** Key of the text node that contains the trigger character. */
    nodeKey: string;
    /** Offset of the `/` or `@` within that node. */
    offset: number;
    /** Text between the trigger and the caret (no whitespace — a space
     *  closes the autocomplete). */
    query: string;
}

/** Stable identity of a trigger (for Esc-dismissal memory). */
export function triggerId(t: TriggerState): string {
    return `${t.nodeKey}:${t.offset}:${t.kind}`;
}

/** Either inline mention kind — both are token TextNodes the caret must
 *  step over and the trigger detector must not read as plain text. */
function $isMentionNode(node: LexicalNode | null | undefined): node is FileMentionNode | CommandMentionNode {
    return $isFileMentionNode(node) || $isCommandMentionNode(node);
}

/** Chars that make a preceding `/` read as part of a path, URL or
 *  identifier ("src/app", "24/7", "https://…") rather than a command
 *  invocation — no command popup while typing those. */
const PATH_CHARS = /[A-Za-z0-9_.\-~/:]/;

/**
 * Detects an open trigger directly before the caret by looking at the
 * ANCHOR TEXT NODE — no serialization, no caret-to-string mapping. The
 * word (non-space run) ending at the caret is scanned right-to-left for
 * a trigger character; a space still closes the autocomplete.
 *
 * Trigger rules:
 *  - `@` (files) fires ANYWHERE — glued to a word is fine ("看这个@src"),
 *    like Slack/Discord mentions. CJK input has no natural spaces, so
 *    requiring a word boundary would make mentions nearly untypable.
 *  - `/` (commands) stays quiet inside paths and identifiers (rejected
 *    when the previous char is a path char) but fires at the start,
 *    after whitespace, punctuation and CJK text ("帮我/new").
 * The RIGHTMOST passing trigger wins, and a `/` rejected as path-internal
 * falls back to an earlier `@` ("a@b/c" is a file query, not a command).
 * Mention nodes are skipped: the caret can legally rest inside one
 * (token text), but a mention is never a trigger. Returns null when not
 * autocompleting.
 */
export function $detectTrigger(): TriggerState | null {
    const sel = $getSelection();
    if (!$isRangeSelection(sel) || !sel.isCollapsed()) return null;
    let node = sel.anchor.getNode();
    let offset = sel.anchor.offset;
    if (!$isTextNode(node) || $isMentionNode(node)) return null;
    let before = node.getTextContent().slice(0, offset);
    // Caret resting at a node boundary: the trigger may sit at the END of
    // the previous text node (left there by a split or an undo). Reading
    // through that boundary keeps behavior identical to plain-text editors.
    if (offset === 0) {
        const prev = node.getPreviousSibling();
        if ($isTextNode(prev) && !$isMentionNode(prev)) {
            node = prev;
            before = prev.getTextContent();
        }
    }
    const run = before.match(/(\S*)$/)![1];
    if (!run) return null;
    const runStart = before.length - run.length;
    // The char physically before the run — reaches across into the
    // previous sibling text node when the run starts the node, so "src"
    // + "/app" in split nodes still reads as one path.
    const prevSibling = node.getPreviousSibling();
    const beforeRun = runStart > 0
        ? before[runStart - 1]
        : $isTextNode(prevSibling)
            ? prevSibling.getTextContent().slice(-1)
            : undefined;
    for (let i = run.length - 1; i >= 0; i--) {
        const ch = run[i];
        if (ch !== "@" && ch !== "/") continue;
        const boundary = i > 0 ? run[i - 1] : beforeRun;
        if (ch === "/" && boundary !== undefined && PATH_CHARS.test(boundary)) continue;
        return {
            kind: ch === "/" ? "command" : "file",
            nodeKey: node.getKey(),
            offset: runStart + i,
            query: run.slice(i + 1),
        };
    }
    return null;
}


/** Atomic ←/→ across a mention (file or command): when the caret sits
 *  inside one (the native caret can land in token text) or right next to
 *  one, land the selection on the FAR side of the whole mention in a
 *  single step. Returns whether it handled the key. */
export function $skipMention(editor: LexicalEditor, direction: -1 | 1): boolean {
    const jump = editor.getEditorState().read((): -1 | 1 | null => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel) || !sel.isCollapsed()) return null;
        const anchor = sel.anchor;
        const node = anchor.getNode();
        if ($isMentionNode(node)) return direction;
        if ($isTextNode(node)) {
            if (direction === -1 && anchor.offset === 0) {
                return $isMentionNode(node.getPreviousSibling()) ? -1 : null;
            }
            if (direction === 1 && anchor.offset === node.getTextContentSize()) {
                return $isMentionNode(node.getNextSibling()) ? 1 : null;
            }
        }
        return null;
    });
    if (jump === null) return false;
    let handled = false;
    editor.update(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return;
        let node = sel.anchor.getNode();
        if (!$isMentionNode(node)) {
            const sibling = direction === -1 ? node.getPreviousSibling() : node.getNextSibling();
            if (!sibling || !$isMentionNode(sibling)) return;
            node = sibling;
        }
        if (direction === -1) node.selectPrevious();
        else node.selectNext();
        handled = true;
    });
    return handled;
}
