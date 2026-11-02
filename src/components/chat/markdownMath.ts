/**
 * Math-delimiter normalization (pure) — the preprocessing half of math
 * rendering. remark-math only understands the `$` / `$$` dollar forms,
 * but plenty of models emit LaTeX's own delimiters (`\(...\)`,
 * `\[...\]`) — and worse, CommonMark's character-escape rule eats those
 * backslashes before any math plugin could see them (`\(` parses down
 * to a bare `(`). This runs on the RAW text before the markdown parse,
 * rewriting the paren/bracket forms into their dollar equivalents.
 *
 * CODE IS SACROSANCT: fenced code blocks and inline code spans pass
 * through verbatim — their `$` and backslashes are content, never math.
 *
 * Replacements use FUNCTION replacements throughout: in a string
 * replacement `$$` collapses to a single literal `$`, which is exactly
 * the bug this file exists to prevent.
 */

/** Rewrite the math delimiters of one NON-code segment of a line. */
function normalizeSegment(segment: string): string {
    // Same-line PAIRS first — they consume both delimiters at once, so
    // the standalone open/close rules below only ever see the cross-line
    // form. Inner padding is absorbed because remark-math rejects a `$`
    // followed (or preceded) by a space: `\( x \)` must become `$x$`,
    // not `$ x $`.
    let out = segment.replace(
        /\\\[ *(.*?) *\\\]/g,
        (_match: string, body: string) => `$$${body}$$`,
    );
    out = out.replace(
        /\\\(\s*(.*?)\s*\\\)/g,
        (_match: string, body: string) => `$${body}$`,
    );
    // Cross-line display math. Block `$$` follows fence syntax — the
    // delimiter must sit ALONE on its line (an opening `$$` with content
    // after it drops that content as an "info string"; a closing `$$`
    // with content before it never closes) — so a `\[`/`\]` carrying
    // formula text flips into a `$$` line PLUS the text on its own line.
    // Attached-to-text delimiters (`a\[b` unpaired, e.g. an escaped
    // bracket) are deliberately left alone.
    out = out.replace(
        /^(\s*)\\\[ *(.*)$/,
        (_m: string, indent: string, rest: string) => (rest === "" ? `${indent}$$` : `${indent}$$\n${rest}`),
    );
    out = out.replace(
        /^(.*) *\\\] *$/,
        (_m: string, rest: string) => {
            const lead = rest.replace(/ +$/, "");
            return lead === "" ? "$$" : `${lead}\n$$`;
        },
    );
    return out;
}

/** Normalize `\(\)`/`\[\]` math delimiters to `$`/`$$`, leaving code
 * (fenced blocks and inline code spans) untouched. */
export function normalizeMathDelimiters(text: string): string {
    const lines = text.split("\n");
    let fence: {marker: string; length: number} | null = null;
    const out = lines.map((line) => {
        if (fence) {
            const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
            if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
                fence = null;
            }
            return line;
        }
        const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (open) {
            fence = {marker: open[1][0], length: open[1].length};
            return line;
        }
        // Split off single-backtick inline code spans; only the
        // non-code segments are rewritten.
        return line
            .split(/(`[^`]*`)/g)
            .map((part, i) => (i % 2 === 1 ? part : normalizeSegment(part)))
            .join("");
    });
    return out.join("\n");
}
