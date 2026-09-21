import {memo} from "react";
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
 */
const Markdown = memo(function Markdown({children}: {children: string}) {
    return (
        <div className="lum-md">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    a: ({href, children}) => (
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
                }}
            >
                {children}
            </ReactMarkdown>
        </div>
    );
});

export default Markdown;
