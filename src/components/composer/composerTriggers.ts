import {
    $createTextNode,
    $getSelection,
    $isElementNode,
    $isLineBreakNode,
    $isRangeSelection,
    $isTextNode,
    mergeRegister,
    type LexicalEditor,
    type LexicalNode,
} from "lexical";
import {CommandMentionNode, $isCommandMentionNode} from "./CommandMentionNode.tsx";
import {FileMentionNode, $isFileMentionNode} from "./FileMentionNode.tsx";

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

/** The mention a COLLAPSED caret would move INTO when moving `direction` —
 *  null when the immediate neighbor isn't a mention. Covers every resting
 *  geometry the caret can take around a token: inside its text, at a
 *  text-node boundary, at a line break (offset 0/1 = before/after it),
 *  and at an element path selection (anchor.offset = child index — the
 *  paragraph start/end geometry). The last two matter because Lexical's
 *  native move ENTERS token text from there, parking the caret between
 *  the icon and the name. */
function $mentionAcross(direction: -1 | 1): FileMentionNode | CommandMentionNode | null {
    const sel = $getSelection();
    if (!$isRangeSelection(sel) || !sel.isCollapsed()) return null;
    const anchor = sel.anchor;
    const node = anchor.getNode();
    if ($isMentionNode(node)) return node;
    if ($isElementNode(node)) {
        // Path selection: the child the caret would move into is the one
        // at anchor.offset (moving right) / offset - 1 (moving left).
        const child = node.getChildren()[direction === -1 ? anchor.offset - 1 : anchor.offset];
        return child !== undefined && $isMentionNode(child) ? child : null;
    }
    // Text nodes (offset 0..size) and line breaks (offset 0/1): only a
    // caret resting AT the boundary edge would cross into the neighbor.
    if ($isTextNode(node)) {
        const atEdge = direction === -1 ? anchor.offset === 0 : anchor.offset === node.getTextContentSize();
        if (!atEdge) return null;
    } else if ($isLineBreakNode(node)) {
        const atEdge = direction === -1 ? anchor.offset === 0 : anchor.offset === 1;
        if (!atEdge) return null;
    } else {
        return null;
    }
    const neighbor = direction === -1 ? node.getPreviousSibling() : node.getNextSibling();
    return neighbor !== null && $isMentionNode(neighbor) ? neighbor : null;
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
 *  inside one (the native caret can land in token text) or would move
 *  into one — from a text edge, a line break or a path selection — land
 *  the selection on the FAR side of the WHOLE mention (its icon region
 *  included) in a single step. Returns whether it handled the key. */
export function $skipMention(editor: LexicalEditor, direction: -1 | 1): boolean {
    if (editor.getEditorState().read(() => $mentionAcross(direction)) === null) return false;
    let handled = false;
    editor.update(() => {
        const mention = $mentionAcross(direction);
        if (mention === null) return;
        if (direction === -1) mention.selectPrevious();
        // Explicit (0, 0) = the point just AFTER the mention. A bare
        // selectNext() passes undefined offsets, which TextNode.select
        // defaults to the node's END — the caret would skip the entire
        // following text run, not just the mention.
        else mention.selectNext(0, 0);
        handled = true;
    });
    return handled;
}

/** A collapsed caret resting INSIDE a mention (click on the icon region,
 *  Home/word jumps the arrow interception can't see) — it renders between
 *  the icon and the name, inside the token's box. */
function $restingInsideMention(): {node: FileMentionNode | CommandMentionNode; offset: number} | null {
    const sel = $getSelection();
    if (!$isRangeSelection(sel) || !sel.isCollapsed()) return null;
    const anchor = sel.anchor;
    const node = anchor.getNode();
    return $isMentionNode(node) ? {node, offset: anchor.offset} : null;
}

/** Keeps a collapsed caret from ever RESTING inside a mention's token
 *  text: $skipMention intercepts arrow crossings, this clamp catches the
 *  remaining entry paths (mouse clicks on the icon area, Home/word
 *  jumps) and snaps the caret out to the NEAREST edge of the whole
 *  token. Selections SPANNING a mention are left alone (selecting
 *  across a token is legitimate), and so is IME composition. */
export function registerMentionCaretClamp(editor: LexicalEditor): () => void {
    return editor.registerUpdateListener(() => {
        if (editor.isComposing()) return;
        if (editor.getEditorState().read(() => $restingInsideMention()) === null) return;
        editor.update(() => {
            const resting = $restingInsideMention();
            if (resting === null) return;
            // Nearest edge of the WHOLE token: the left half (a click on
            // the icon maps to offset 0) lands before the box, the right
            // half after it.
            if (resting.offset * 2 <= resting.node.getTextContentSize()) resting.node.selectPrevious();
            else resting.node.selectNext(0, 0);
        });
    });
}

/**
 * A LEADING mention (first child of its paragraph) has no stable caret
 * position before its box: mentions are TextNodes, so Lexical's selection
 * normalization funnels every "before it" point — element selections
 * ($normalizePoint pushes them into adjacent text children) and clicks
 * WebKit resolves into the token — down to text offset 0, which renders
 * BETWEEN the icon and the name. With text in front ("fewa @file") the
 * same normalization instead hops to that text's end, which is why the
 * mid-line geometry already works. The fix mirrors it: a leading mention
 * keeps an invisible EMPTY text anchor in front of it (a real text
 * position for the caret to rest at — the same anchor `accept() creates
 * when splicing in the token, which $normalizeTextNode eats again unless
 * it is marked unmergeable). Maintained by node transforms: added when a
 * mention becomes the paragraph's first child, and simply absorbed by
 * typing (text goes into the anchor node, turning it into the regular
 * text node). */
export function registerMentionAnchors(editor: LexicalEditor): () => void {
    const maintain = (mention: FileMentionNode | CommandMentionNode) => {
        if (mention.getPreviousSibling() !== null) return;
        const anchor = $createTextNode("");
        anchor.toggleUnmergeable(); // survive $normalizeTextNode's empty-node sweep
        mention.insertBefore(anchor);
    };
    return mergeRegister(
        editor.registerNodeTransform(FileMentionNode, maintain),
        editor.registerNodeTransform(CommandMentionNode, maintain),
    );
}
