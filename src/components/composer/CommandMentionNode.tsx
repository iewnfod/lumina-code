import {
    $applyNodeReplacement,
    TextNode,
    type EditorConfig,
    type LexicalNode,
    type NodeKey,
    type SerializedTextNode,
    type Spread,
} from "lexical";

/** What a `/`-picked command carries: just its name (arguments stay plain
 *  text after the mention — they belong to the prompt, not the token). */
export interface CommandMentionData {
    name: string;
}

export type SerializedCommandMentionNode = Spread<
    {data: CommandMentionData; type: "command-mention"; version: 1},
    SerializedTextNode
>;

/** Accent color for command mentions — shared with the suggestion list's
 *  Terminal icon so a picked row previews its final look. */
export const COMMAND_MENTION_COLOR = "#a78bfa";

/**
 * Inline slash-command mention rendered as a TOKEN TextNode, mirroring
 * {@link FileMentionNode}: the text is `/name`, styled as violet text
 * with a small terminal icon (see `.lum-command-mention` in main.css —
 * the icon rides in as a background-image data URI set per node). Token
 * mode keeps the mention atomic (caret skips it, Backspace deletes it
 * whole) while movement, selection and undo stay native.
 *
 * Serializes to plain `/name` text, so submit-time command parsing needs
 * no special casing: a leading command mention plus trailing argument
 * text reads exactly like the typed form.
 */
export class CommandMentionNode extends TextNode {
    __data: CommandMentionData;

    static getType(): string {
        return "command-mention";
    }

    static clone(node: CommandMentionNode): CommandMentionNode {
        return new CommandMentionNode(node.__data, node.__key);
    }

    static importJSON(json: SerializedCommandMentionNode): CommandMentionNode {
        const node = new CommandMentionNode(json.data);
        node.setFormat(json.format ?? 0);
        node.setDetail(json.detail ?? 0);
        node.setMode(json.mode ?? "token");
        node.setStyle(json.style ?? "");
        return node;
    }

    constructor(data: CommandMentionData, key?: NodeKey) {
        super(`/${data.name}`, key);
        this.__data = data;
    }

    exportJSON(): SerializedCommandMentionNode {
        const json = super.exportJSON();
        return {...json, type: "command-mention", version: 1, data: this.__data};
    }

    /** Violet-text look with a small terminal glyph; the chrome (padding,
     *  positioning) lives in the `.lum-command-mention` CSS class. */
    createDOM(config: EditorConfig): HTMLElement {
        const dom = super.createDOM(config);
        dom.className = "lum-command-mention";
        dom.title = `/${this.__data.name}`;
        dom.style.color = COMMAND_MENTION_COLOR;
        dom.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${COMMAND_MENTION_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6M12 19h8"/></svg>`,
        )}")`;
        return dom;
    }

    /** Mentions are immutable (never retargeted in place) — rebuild only
     *  if the text actually changed. Base signature is `this`-typed,
     *  which a subclass override can't satisfy, so compare directly. */
    updateDOM(prevNode: CommandMentionNode): boolean {
        return prevNode.__text !== this.__text || prevNode.__data.name !== this.__data.name;
    }

    getName(): string {
        return this.__data.name;
    }
}

export function $createCommandMentionNode(data: CommandMentionData): CommandMentionNode {
    const node = new CommandMentionNode(data);
    node.setMode("token");
    return $applyNodeReplacement(node);
}

/** TextNode subclass — check BEFORE $isTextNode (it answers true for it). */
export function $isCommandMentionNode(node: LexicalNode | null | undefined): node is CommandMentionNode {
    return node instanceof CommandMentionNode;
}
