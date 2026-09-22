/**
 * Markdown block chunking (pure) — the streaming-parse optimization.
 * splitMarkdownBlocks cuts a markdown document at blank-line boundaries
 * into chunks that each parse identically on their own, so Markdown.tsx
 * can memoize per chunk: while a message streams, only the TAIL chunk
 * (the block currently being written) re-parses per delta instead of
 * the whole document, and settled chunks keep their DOM nodes.
 *
 * Splitting is CONSERVATIVE by design. Merging is always safe (the real
 * parser still sees contiguous text); a cut is only made where both
 * sides are provably independent blocks. The CommonMark/GFM constructs
 * that can span a blank line are loose lists, HTML blocks of the
 * kinds that don't end at a blank line, and reference-style definitions
 * (link reference definitions + footnote definitions, which resolve
 * document-wide and may be separated from their usages by other
 * blocks). Boundaries adjacent to any of those are left uncut, and a
 * document containing a reference definition or an HTML block start
 * anywhere falls back to a single chunk.
 *
 * Stability property (what memoization relies on): a chunk's text never
 * changes after another chunk has been cut after it — chunks only grow
 * while they are the tail. Node-tested in markdownBlocks.test.ts.
 */

/**
 * Below this size a document stays one chunk: parsing it is trivial and
 * chunking would only add component overhead (plus one boundary case —
 * the split of a short message as it crosses the threshold — which this
 * avoids for the common short reply).
 */
const SINGLE_CHUNK_MAX = 400;

/** A list marker at up to 3 spaces of indent (a deeper indent is code). */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
/** A link reference / footnote definition — `[^fn]: …` shares the shape. */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]*\]:/;
/** 4+ spaces or a tab — indented code, or a continuation of a list item. */
const INDENTED = /^(?: {4}|\t)/;
/** An HTML block start (tag, closing tag, comment, declaration). `< 5`
 * (comparison) deliberately doesn't match — CommonMark agrees it's text. */
const HTML_BLOCK = /^ {0,3}<[A-Za-z/!]/;

/** May this line sit next to a cut boundary? Lines that could belong to
 * a construct spanning the blank line force the boundary to stay whole. */
function boundarySafe(line: string): boolean {
    return !INDENTED.test(line) && !LIST_ITEM.test(line)
        && !REFERENCE_DEFINITION.test(line) && !HTML_BLOCK.test(line);
}

/** Cut `text` into independently-parseable block chunks. Concatenating
 * the result reproduces the input exactly. */
export function splitMarkdownBlocks(text: string): string[] {
    if (text.trim() === "") return [];
    if (text.length <= SINGLE_CHUNK_MAX) return [text];
    // Reference definitions resolve document-wide (and may appear after
    // their usage, separated from it by arbitrary blocks), and HTML
    // blocks can span blank lines — neither can be chunked safely, so
    // such documents keep today's whole-document parse.
    const lines = text.split("\n");
    if (lines.some((line) => REFERENCE_DEFINITION.test(line) || HTML_BLOCK.test(line))) {
        return [text];
    }

    // Line indices where a new chunk starts (first non-blank line after
    // a qualifying blank run, outside fenced code).
    const cuts: number[] = [];
    let fence: {marker: string; length: number} | null = null;
    let prevNonBlank = -1;
    for (let i = 0; i < lines.length;) {
        const line = lines[i];
        if (fence) {
            // A closing fence: same character, at least as long, nothing
            // but whitespace after it. Any other line is fence content.
            const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
            if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
                fence = null;
            }
            prevNonBlank = i;
            i++;
            continue;
        }
        if (line.trim() === "") {
            let next = i;
            while (next < lines.length && lines[next].trim() === "") next++;
            if (
                next < lines.length
                && prevNonBlank >= 0
                && boundarySafe(lines[prevNonBlank])
                && boundarySafe(lines[next])
            ) {
                // The blank run stays with the chunk on its left.
                cuts.push(next);
            }
            i = next;
            continue;
        }
        const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (open) fence = {marker: open[1][0], length: open[1].length};
        prevNonBlank = i;
        i++;
    }

    // Chunk boundaries as CHARACTER offsets (start of the first line
    // after each qualifying blank run). Slicing the original text —
    // rather than re-joining lines — keeps each chunk's trailing blank
    // lines verbatim, which is what makes a settled chunk's text freeze
    // the moment a later chunk appears (the memoization contract).
    const starts: number[] = [];
    let pos = 0;
    for (const line of lines) {
        starts.push(pos);
        pos += line.length + 1;
    }
    const chunks: string[] = [];
    let start = 0;
    for (const cut of cuts) {
        chunks.push(text.slice(start, starts[cut]));
        start = starts[cut];
    }
    chunks.push(text.slice(start));
    return chunks;
}
