import {
    $applyNodeReplacement,
    TextNode,
    type EditorConfig,
    type LexicalNode,
    type NodeKey,
    type SerializedTextNode,
    type Spread,
} from "lexical";
import {fileIconUrl} from "../../lib/fileIcons.ts";

/** What a `@`-picked file carries: the short display path (relative to the
 *  session directory) and the absolute path used when sending. */
export interface FileMentionData {
    absolute: string;
    relative: string;
}

export type SerializedFileMentionNode = Spread<
    {data: FileMentionData; type: "file-mention"; version: 1},
    SerializedTextNode
>;

/**
 * Inline file mention rendered as a TOKEN TextNode: the text is `@relative`,
 * styled as medium-weight text with a small colorful file-type icon (see
 * `.lum-file-mention` in main.css) — deliberately not a chip/pill, which
 * reads too heavy inline. The icon (a background-image URL resolved from
 * the Material Icon Theme via lib/fileIcons.ts) is set inline in
 * `createDOM`, so no extra DOM nodes exist and text metrics
 * stay native. Token mode keeps the mention atomic — the caret skips it as
 * one character and Backspace deletes it whole — while movement, selection
 * and undo stay 100% native, including on WebKitGTK where non-editable
 * decorator islands strand the caret.
 */
export class FileMentionNode extends TextNode {
    __data: FileMentionData;

    static getType(): string {
        return "file-mention";
    }

    static clone(node: FileMentionNode): FileMentionNode {
        return new FileMentionNode(node.__data, node.__key);
    }

    static importJSON(json: SerializedFileMentionNode): FileMentionNode {
        const node = new FileMentionNode(json.data);
        node.setFormat(json.format ?? 0);
        node.setDetail(json.detail ?? 0);
        node.setMode(json.mode ?? "token");
        node.setStyle(json.style ?? "");
        return node;
    }

    constructor(data: FileMentionData, key?: NodeKey) {
        super(`@${data.relative}`, key);
        this.__data = data;
    }

    exportJSON(): SerializedFileMentionNode {
        const json = super.exportJSON();
        return {...json, type: "file-mention", version: 1, data: this.__data};
    }

    /** Medium-weight text + a small file-type icon (Material Icon Theme,
     *  resolved per path) as an inline background image. The chrome
     *  (padding, positioning) lives in the `.lum-file-mention` CSS class. */
    createDOM(config: EditorConfig): HTMLElement {
        const dom = super.createDOM(config);
        dom.className = "lum-file-mention";
        dom.title = this.__data.absolute;
        dom.style.backgroundImage = `url("${fileIconUrl(this.__data.relative)}")`;
        return dom;
    }

    /** Mentions are immutable (never retargeted in place) — rebuild only if
     *  text or target actually changed (the icon derives from the path, so
     *  a text change covers re-iconing). Base signature is `this`-typed,
     *  which a subclass override can't satisfy, so compare directly. */
    updateDOM(prevNode: FileMentionNode): boolean {
        return (
            prevNode.__text !== this.__text ||
            prevNode.__style !== this.__style ||
            prevNode.__data.absolute !== this.__data.absolute
        );
    }

    getAbsolute(): string {
        return this.__data.absolute;
    }

    getRelative(): string {
        return this.__data.relative;
    }
}

export function $createFileMentionNode(data: FileMentionData): FileMentionNode {
    const node = new FileMentionNode(data);
    node.setMode("token");
    return $applyNodeReplacement(node);
}

/** TextNode subclass — check BEFORE $isTextNode (it answers true for it). */
export function $isFileMentionNode(node: LexicalNode | null | undefined): node is FileMentionNode {
    return node instanceof FileMentionNode;
}
