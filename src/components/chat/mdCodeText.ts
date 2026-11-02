import type {ReactNode} from "react";

/**
 * Raw-text extraction from a react-markdown node tree (pure) — feeds the
 * code-block copy button in Markdown.tsx's MdPre. The `pre` override
 * receives the rendered <code> element as its children; walking
 * props.children recursively collects exactly the code text the model
 * emitted, whatever shape react-markdown chose for it (single string,
 * nested elements, mixed arrays).
 *
 * Element nodes are recognized by duck type (an object carrying `props`)
 * rather than isValidElement on purpose: this module must stay loadable
 * by node:test without a value-import of react (the type-only import
 * above is erased by type stripping). Markdown code content is always
 * plain strings, so the duck-typed walk is complete for real trees.
 * Node-tested in mdCodeText.test.ts.
 */

function collect(node: ReactNode, out: string[]): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") {
        out.push(String(node));
        return;
    }
    if (Array.isArray(node)) {
        for (const child of node) collect(child, out);
        return;
    }
    if (typeof node === "object" && "props" in node) {
        const props = (node as {props?: {children?: ReactNode}}).props;
        if (props && typeof props === "object") collect(props.children, out);
    }
    // Anything else contributes nothing — markdown code content never
    // renders iterables/portals/fragments without props.
}

/** The concatenated text of `node`'s subtree, with trailing whitespace
 * dropped: fenced blocks close with the newline before ```, and a
 * clipboard copy should not carry that blank tail into the paste
 * target. */
export function mdCodeText(node: ReactNode): string {
    const out: string[] = [];
    collect(node, out);
    return out.join("").replace(/\s+$/, "");
}
