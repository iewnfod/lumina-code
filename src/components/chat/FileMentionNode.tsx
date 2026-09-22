import {
    $applyNodeReplacement,
    TextNode,
    type EditorConfig,
    type LexicalNode,
    type NodeKey,
    type SerializedTextNode,
    type Spread,
} from "lexical";

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
 * Inline file chip rendered as a TOKEN TextNode: the text is `@relative`,
 * styled (pill + icon) via `createDOM`. Token mode makes the whole chip
 * atomic — the caret skips over it as one character and Backspace deletes
 * it in one press — while movement/selection/undo stay 100% native,
 * including on WebKitGTK where non-editable decorator islands strand the
 * caret. (A previous DecoratorNode version did exactly that.)
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

    /** Pill look: tinted background + a small file-type icon as inline
     *  background image (no extra DOM nodes, so text metrics stay native). */
    createDOM(config: EditorConfig): HTMLElement {
        const dom = super.createDOM(config);
        const style = fileStyle(this.__data.relative);
        dom.className = "lum-file-mention";
        dom.title = this.__data.absolute;
        dom.style.backgroundImage = `url("data:image/svg+xml,${svgDataUrl(style)}")`;
        dom.style.backgroundRepeat = "no-repeat";
        dom.style.backgroundPosition = "3px center";
        dom.style.backgroundSize = "12px 12px";
        return dom;
    }

    /** Chips are immutable (never retargeted in place) — rebuild only if
     *  text or target actually changed. Base signature is `this`-typed,
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

// --- Icon per file category: minimal lucide-style SVG strokes, tinted per
//     type (code / data / style / image / shell / generic). ---

interface FileStyle {
    color: string;
    /** Which lucide path to draw. */
    path: string;
}

function fileStyle(path: string): FileStyle {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go", "py", "java", "kt", "c", "h", "cpp", "rb"].includes(ext)) {
        return {color: "#60a5fa", path: "M10 12.5 8 15l2 2.5M16 12.5 18 15l-2 2.5M14 11.5l-2 6"};
    }
    if (["json", "json5", "jsonc", "yaml", "yml", "toml", "ini", "env"].includes(ext)) {
        return {color: "#fbbf24", path: "M8 4c0 2.5-4 1.5-4 4s4 1.5 4 4-4 1.5-4 4 4 1.5 4 4M16 4c0 2.5 4 1.5 4 4s-4 1.5-4 4 4 1.5 4 4-4 1.5-4 4"};
    }
    if (["css", "scss", "less", "html", "svg"].includes(ext)) {
        return {color: "#f472b6", path: "M12 3v18M5 8l7-5 7 5-7 5z"};
    }
    if (["png", "jpg", "jpeg", "gif", "webp", "ico", "avif"].includes(ext)) {
        return {color: "#34d399", path: "M4 17l5-5 3 3 4-4 4 4M6 5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"};
    }
    if (["sh", "bash", "zsh", "fish"].includes(ext)) {
        return {color: "#a78bfa", path: "M5 8l4 3-4 3M11 15h8"};
    }
    return {color: "rgba(150,150,150,0.9)", path: "M15 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7zM14 3v5h5"};
}

function svgDataUrl(style: FileStyle): string {
    return encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${style.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${style.path}"/></svg>`,
    );
}
