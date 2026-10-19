import {$getRoot, $isElementNode} from "lexical";
import {$isFileMentionNode} from "./FileMentionNode.tsx";

/**
 * Serialize the composer's editor state into the SENT payload — the
 * node-tree walk ComposerCore's submit ran inline before this file
 * existed (the composerTriggers.ts precedent: Lexical node algorithms
 * live beside the nodes they read). MUST run inside
 * `editor.getEditorState().read(() => …)` — the Lexical convention for
 * tree reads.
 *
 * Returns the plain text (mention tokens re-prefixed with "@" so the
 * server resolves the "@relative" form; the token itself displays icon +
 * bare file name; Shift+Enter line breaks ride getTextContent) plus the
 * absolute paths the mention tokens carry.
 */
export function readSubmitPayload(): {text: string; paths: string[]} {
    let text = "";
    const paths: string[] = [];
    $getRoot().getChildren().forEach((block, bi) => {
        if (bi > 0) text += "\n";
        for (const child of $isElementNode(block) ? block.getChildren() : []) {
            if ($isFileMentionNode(child)) {
                paths.push(child.getAbsolute());
                text += `@${child.getRelative()}`;
                continue;
            }
            text += child.getTextContent();
        }
    });
    return {text, paths};
}
