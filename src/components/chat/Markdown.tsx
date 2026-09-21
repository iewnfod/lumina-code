import {memo, type ReactNode} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {openUrl} from "@tauri-apps/plugin-opener";

/**
 * Markdown renderer for assistant text. Scoped styles live under `.lum-md`
 * in main.css so the chat typography stays part of the design-token system
 * (radii, mono font) instead of a parallel stylesheet. Links open in the
 * system browser — the webview must never navigate away.
 *
 * Memoized: the markdown tree only re-parses when its text changes, which
 * during streaming is exactly one message.
 *
 * CRITICAL: the custom component map lives at module scope. Defining it
 * inline in the render creates new component types each render, which
 * unmounts and remounts the entire markdown subtree on every streamed
 * token — replaying entrance animations for the whole message (this was
 * the root cause of the streaming flicker). With stable identities React
 * reconciles by position and reuses DOM nodes, so the block-level
 * entrance fade (`.lum-md > *` in main.css) runs only when a block is
 * genuinely created.
 */

// Module scope — stable component identities across renders (see the
// CRITICAL note in the header comment).
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

const Markdown = memo(function Markdown({children}: {children: string}) {
    return (
        <div className="lum-md">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={mdComponents}
            >
                {children}
            </ReactMarkdown>
        </div>
    );
});

export default Markdown;
