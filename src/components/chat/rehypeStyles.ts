/**
 * rehype inline-style objectifier — the WORKAROUND for the
 * style-to-js CJS interop break (2026-11, live-observed in BOTH the
 * dev server's .vite/deps prebundle and the rolldown build):
 *
 *   hast-util-to-jsx-runtime converts a hast `style` STRING by calling
 *   `styleToJs` from the `style-to-js` package — a pre-`exports`-field
 *   CJS build whose default export is a DYNAMIC key
 *   (`exports["default"] = fn`), which interop fails to detect, so the
 *   default import binds to the whole exports object: `TypeError:
 *   styleToJs is not a function`. The error is CAUGHT per-attribute and
 *   the style is DROPPED SILENTLY — KaTeX's DOM positions entirely via
 *   inline styles (`top:-3em`, `height:0.8em` on every vlist layer), so
 *   every formula lost its script positioning and piled its levels
 *   downward (superscripts a full line low, no math italics).
 *
 * The same converter takes an `style` OBJECT verbatim (no styleToJs
 * call), so this plugin rewrites every element's style STRING into an
 * object right after rehype-katex emits it. Pure, node-tested.
 */

/** Minimal hast element shape (avoids importing type-only packages). */
interface HastNode {
    type: string;
    tagName?: string;
    properties?: Record<string, unknown>;
    children?: HastNode[];
}

/** Kebab-case CSS property → React's camelCase, preserving custom
 * properties (`--var`) which React passes through verbatim. */
export function stylePropertyName(name: string): string {
    if (name.startsWith("--")) return name;
    return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Parse an inline style STRING (`top:-3em;height:0.8em;`) into the
 * object shape React's style prop takes. Same semantics as
 * style-to-js: skips empty parts, trims, camelCases keys. */
export function parseInlineStyle(style: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const decl of style.split(";")) {
        const colon = decl.indexOf(":");
        if (colon === -1) continue;
        const name = decl.slice(0, colon).trim();
        const value = decl.slice(colon + 1).trim();
        if (name === "" || value === "") continue;
        out[stylePropertyName(name)] = value;
    }
    return out;
}

/** Recursively objectify every element's inline style string. */
function objectifyStyles(node: HastNode): void {
    for (const child of node.children ?? []) objectifyStyles(child);
    const props = node.properties;
    if (props && typeof props.style === "string") {
        props.style = parseInlineStyle(props.style);
    }
}

/** The rehype plugin: string styles → object styles, so
 * hast-util-to-jsx-runtime never reaches for the broken styleToJs. */
export function rehypeInlineStyles() {
    return function transform(tree: HastNode) {
        objectifyStyles(tree);
    };
}
