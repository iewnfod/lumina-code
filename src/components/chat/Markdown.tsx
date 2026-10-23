import {memo, createContext, useContext, type ReactNode} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {openUrl} from "@tauri-apps/plugin-opener";
import {Check, Copy} from "lucide-react";
import {fadeClasses, useScrollEdges} from "../../hooks/useScrollEdges.ts";
import {useCopy} from "../../hooks/useCopy.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {isOfficeDocument} from "../../opencode/docstruct.ts";
import {requestStatsDocumentDrill} from "../../hooks/useStatsPanelMode.ts";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import Hint from "../ui/Hint.tsx";
import {splitMarkdownBlocks} from "./markdownBlocks.ts";
import {mdCodeText} from "./mdCodeText.ts";

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

// Code blocks: the PRE keeps its wash/radius/padding (chrome) and this
// SPAN (display: block via CSS — a div would be invalid inside pre) is
// the horizontal scroller wearing the CONDITIONAL fades — a block that
// fits its column renders mask-free; each side fades only while code is
// actually hidden beyond it.
//
// The COPY affordance: MdPre wraps everything in a host span
// (.lum-md-pre-host, display:block + relative) so the floating button
// can live OUTSIDE the pre — Hint's trigger wrapper is a div, which
// must not enter pre (phrasing content only). The button fades in on
// host hover and copies the code's raw text (mdCodeText extracts it
// lazily at click time, so streaming renders never pay for it), with
// the shared useCopy ✓ linger. The chip's chrome (elevated surface,
// reveal ladder, translateZ compositing for WebKitGTK) lives with the
// other .lum-md styles in main.css.
function MdPre({children}: {children?: ReactNode}) {
    const edges = useScrollEdges<HTMLSpanElement>();
    const {copied, copy} = useCopy();
    const t = useI18n();
    return (
        <span className="lum-md-pre-host">
            <pre>
                <span
                    ref={edges.ref}
                    onScroll={edges.onScroll}
                    className={`lum-md-pre-scroll${fadeClasses(edges)}`}
                >
                    {children}
                </span>
            </pre>
            <Hint label={copied ? t["Copied"] : t["Copy"]}>
                <button
                    type="button"
                    onClick={() => void copy(mdCodeText(children))}
                    className={`lum-md-copy${copied ? " copied" : ""}`}
                >
                    {copied
                        ? <Check size={14} className="shrink-0"/>
                        : <Copy size={14} className="shrink-0"/>}
                </button>
            </Hint>
        </span>
    );
}

// Tables: chrome/scroller split (the fade-system rule — masks multiply
// into backgrounds, so the border+radius live on the .lum-md-table wrap
// and the .lum-md-table-scroll div inside is the horizontal scroller).
// The horizontal fades are WIDTH-AWARE: a table that fits its column
// renders mask-free; each side fades only while content is actually
// hidden beyond it (useScrollEdges' left/right flags).
function MdTable({children}: {children?: ReactNode}) {
    const edges = useScrollEdges<HTMLDivElement>();
    return (
        <div className="lum-md-table">
            <div
                ref={edges.ref}
                onScroll={edges.onScroll}
                className={`lum-md-table-scroll${fadeClasses(edges)}`}
            >
                <table>{children}</table>
            </div>
        </div>
    );
}

/**
 * The workspace directory OFFICE-DOCUMENT LINKS in assistant text
 * resolve against (AssistantBlock provides the session's directory;
 * every other Markdown consumer — gate cards, tool outputs, todo
 * documents, subagent reports — stays un-provided and keeps the plain
 * link behavior). A context rather than a prop so the module-scoped
 * component map (the streaming-performance invariant above) keeps its
 * stable identities — memoized blocks re-render on a context CHANGE
 * only, which is exactly a directory switch.
 */
export const MarkdownWorkspaceContext = createContext<string | null>(null);

/** Decode a link's href defensively: markdown sources usually keep
 * non-ASCII verbatim, but a %-encoded path (spaces, brackets) must not
 * defeat the office-extension check or the drill path. */
function decodeHref(href: string): string {
    try {
        return decodeURIComponent(href);
    } catch {
        return href; // a lone '%' survivor — take it verbatim
    }
}

/** One markdown link. An OFFICE-document href (absolute, or relative to
 * the provided workspace) renders as the `.lum-file-mention` chip — the
 * @-file token's look — and clicking drills the workspace-activity
 * panel into the document's preview (requestStatsDocumentDrill; the
 * row's real byte count arrives with the panel's refresh). Everything
 * else stays the system-browser link. */
function MdLink({href, children}: {href?: string; children?: ReactNode}) {
    const workspace = useContext(MarkdownWorkspaceContext);
    const decoded = typeof href === "string" ? decodeHref(href) : "";
    const absolute =
        decoded.startsWith("/") ? decoded
        : workspace && decoded !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(decoded)
            ? `${workspace.replace(/\/+$/, "")}/${decoded.replace(/^\.?\//, "")}`
            : null;
    if (absolute !== null && isOfficeDocument(absolute)) {
        return (
            <button
                type="button"
                // Exempt from the stats panel's outside-click collapse —
                // this click AIMS the panel, same as the turn-edit rows.
                data-lum-stats-drill
                className="lum-file-mention lum-md-doc"
                style={{backgroundImage: `url("${fileIconUrl(absolute)}")`}}
                onClick={() => requestStatsDocumentDrill({path: absolute, size: 0, change: null})}
            >
                {children}
            </button>
        );
    }
    return (
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
    );
}

// Module scope — stable component identities across renders (see the
// PERFORMANCE note in the header comment).
const mdComponents = {
    a: MdLink,
    table: MdTable,
    pre: MdPre,
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
