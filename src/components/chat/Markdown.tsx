import {memo, type ReactNode} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {openUrl} from "@tauri-apps/plugin-opener";
import {splitMarkdownBlocks} from "./markdownBlocks.ts";

/**
 * Markdown renderer for assistant text. Scoped styles live under `.lum-md`
 * in main.css so the chat typography stays part of the design-token system
 * (radii, mono font) instead of a parallel stylesheet. Links open in the
 * system browser — the webview must never navigate away.
 *
 * PERFORMANCE — two mechanisms keep streaming cheap (this was the frame
 * dropper on WebKitGTK):
 *
 * 1. The text is split into block chunks (markdownBlocks.ts) and each
 *    chunk renders through its own memoized MarkdownBlock. A chunk's text
 *    freezes once a later chunk exists, so during a stream only the TAIL
 *    chunk re-parses per delta — O(current block), not O(whole message) —
 *    and settled chunks keep their component instances and DOM nodes.
 *
 * 2. The custom component map lives at module scope. Defining it inline
 *    in the render creates new component types each render, which
 *    unmounts and remounts the entire markdown subtree on every streamed
 *    token — replaying entrance animations for the whole message (this was
 *    the root cause of the streaming flicker). With stable identities React
 *    reconciles by position and reuses DOM nodes, so the block-level
 *    entrance fade (`.lum-md.live > *` in main.css) runs only when a block
 *    is genuinely created.
 *
 * The `live` flag marks the message currently streaming: it is what scopes
 * the CSS entrance fade. Historical messages render fully opaque with no
 * animations — bulk-mounting a session's history (60 entries × every
 * block) used to start hundreds of concurrent opacity animations and drop
 * frames; now only genuinely-live blocks animate.
 */

// Module scope — stable component identities across renders (see the
// PERFORMANCE note in the header comment).
const mdComponents = {
    a: ({href, children}: {href?: string; children?: ReactNode}) => (
        <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
                e.preventDefault();
                if (href) openUrl(href).catch(() => {});
            }}
        >
            {children}
        </a>
    ),
};

/** One block chunk. Memoized on its text: while a message streams only
 * the tail chunk's text changes, so every settled chunk skips re-parsing
 * AND keeps its DOM (no entrance replays). ReactMarkdown renders a
 * fragment of block elements — chunks stay invisible wrappers and the
 * `.lum-md > block` scoped styles keep working unchanged. */
const MarkdownBlock = memo(function MarkdownBlock({children}: {children: string}) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={mdComponents}
        >
            {children}
        </ReactMarkdown>
    );
});

const Markdown = memo(function Markdown({children, live}: {children: string; live?: boolean}) {
    const chunks = splitMarkdownBlocks(children);
    return (
        <div className={live ? "lum-md live" : "lum-md"}>
            {chunks.map((chunk, i) => (
                <MarkdownBlock key={i}>{chunk}</MarkdownBlock>
            ))}
        </div>
    );
});

export default Markdown;
