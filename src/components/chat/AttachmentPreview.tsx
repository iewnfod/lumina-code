import {memo, useEffect, useMemo, useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {useScrollEdges} from "../../hooks/useScrollEdges.ts";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {capPreviewLines, PREVIEW_MAX_LINES, type AttachmentPreviewSource} from "./attachmentPreview.ts";
import {fragmentHunks} from "./toolDiff.ts";
import DiffViewBody from "./DiffViewBody.tsx";

/**
 * The user bubble's attachment-chip preview (the expanded half of
 * MessageItem's AttachmentChips): one attachment at a time, mounted
 * under the chips with a key per chip so switches remount fresh.
 *
 * Ready sources (data-URI images, decoded text) render immediately;
 * `read` sources fetch through the server's location-confined fs/read —
 * images as a Blob → object URL (revoked on unmount/swap), text via
 * readTextFile. Text/code renders in the WORKSPACE display (the same
 * DiffViewBody the stats panel's file drill uses): the whole file as
 * context rows through fragmentHunks — numbered, syntax-highlighted
 * code with no diff wash — capped at PREVIEW_MAX_LINES with a
 * truncation footnote.
 *
 * Entrance/exit animation is the parent's business (ExitPresence +
 * .lum-enter/.lum-fade-exit in MessageItem); this component only
 * renders its states.
 */

/** The fetch states for a `read` source; null = still loading. */
type FetchedState = {url: string} | {text: string} | "error" | null;

const AttachmentPreview = memo(function AttachmentPreview({source}: {source: AttachmentPreviewSource}) {
    const t = useI18n();
    const colors = useColors();
    const {api} = useConnection();
    const [fetched, setFetched] = useState<FetchedState>(null);
    // Conditional edge fades for the text preview's scroller (hooks before
    // the early returns below).
    const edges = useScrollEdges<HTMLDivElement>();

    // Hooks first (early returns below): resolve the renderable payload
    // from whichever side of the source union we're on.
    const textContent = source.kind === "text"
        ? ("content" in source
            ? source.content
            : fetched != null && fetched !== "error" && "text" in fetched ? fetched.text : null)
        : null;
    const imageSrc = source.kind === "image"
        ? ("src" in source
            ? source.src
            : fetched != null && fetched !== "error" && "url" in fetched ? fetched.url : null)
        : null;
    const {lines, truncated} = useMemo(
        () => (textContent == null ? {lines: [] as string[], truncated: false} : capPreviewLines(textContent)),
        [textContent],
    );
    // Whole file as ADDED rows. NOTE: git-diff-view drops all-context
    // hunks — a hunk with no add/del builds ZERO rows (verified against
    // @git-diff-view 0.1.7) — so the diff semantics (green wash, "+"
    // signs, marker strips) are neutralized for this surface in
    // diffView.css (.lum-attachment-diff), leaving plain numbered,
    // highlighted code: the workspace file view's look.
    const hunks = useMemo(
        () => lines.length > 0 && !(lines.length === 1 && lines[0] === "")
            ? fragmentHunks(lines.map((text) => ({kind: "add" as const, text})), source.name)
            : [],
        [lines, source.name],
    );

    useEffect(() => {
        if (!("read" in source)) return;
        let cancelled = false;
        let createdUrl: string | null = null;
        setFetched(null);
        (async () => {
            if (!api) {
                setFetched("error");
                return;
            }
            try {
                if (source.kind === "image") {
                    const blob = await api.readFileBlob(source.read.directory, source.read.name);
                    if (blob == null) throw new Error("file not found");
                    const url = URL.createObjectURL(blob);
                    if (cancelled) {
                        URL.revokeObjectURL(url);
                        return;
                    }
                    createdUrl = url;
                    setFetched({url});
                } else {
                    const text = await api.readTextFile(source.read.directory, source.read.name);
                    if (text == null) throw new Error("file not found");
                    if (!cancelled) setFetched({text});
                }
            } catch (e) {
                logError(`Attachment preview failed (${source.read.directory}/${source.read.name}): ${e}`).catch(() => {});
                if (!cancelled) setFetched("error");
            }
        })();
        return () => {
            cancelled = true;
            if (createdUrl) URL.revokeObjectURL(createdUrl);
        };
    }, [source, api]);

    if (imageSrc != null) {
        return (
            // Right-aligned with the chips row / bubble above (the user
            // column is items-end); height-capped so a screenshot
            // doesn't swallow the transcript.
            <div className="flex justify-end">
                <img
                    src={imageSrc}
                    alt={source.name}
                    className="max-h-[min(55vh,400px)] rounded-[var(--radius-lg)]"
                    style={{border: `1px solid ${colors.glassBorder}`}}
                />
            </div>
        );
    }
    if (textContent != null) {
        return (
            <div className="flex flex-col gap-1">
                {/* The workspace display's recessed reading surface (the
                    stats panel's BodyBox shape) with the shared EDGE FADE
                    (main.css's fade-system classes): the mask rides the
                    INNER scroller — viewport-fixed, so rows dissolve as
                    they cross the scroll boundary — while the fill +
                    rounded clip stay on the outer box, because masks
                    multiply into backgrounds (never mask the painted
                    surface itself). CONDITIONAL and BOTTOM-ONLY: the fade
                    appears solely while rows are actually hidden past the
                    bottom edge (a file that fits the 55vh cap renders
                    mask-free), and the TOP never fades — the panel opens
                    at scroll-top, so a top band would dissolve the file's
                    first lines into nothing at rest. */}
                <div
                    className="rounded-[var(--radius-lg)] max-h-[55vh] overflow-hidden"
                    style={{background: colors.recessedBg}}
                >
                    <div
                        ref={edges.ref}
                        onScroll={edges.onScroll}
                        className={`max-h-[55vh] overflow-auto lum-fade-lg${edges.bottom ? " lum-fade-bottom" : ""}`}
                    >
                        <div className="px-3 py-3">
                            {hunks.length > 0
                                ? (
                                    <div className="lum-attachment-diff">
                                        <DiffViewBody hunks={hunks} fileName={source.name}/>
                                    </div>
                                )
                                : <span className="opacity-40 text-sm select-none">{t["Preview unavailable"]}</span>}
                        </div>
                    </div>
                </div>
                {truncated && (
                    <span className="text-2xs opacity-40 select-none">
                        {t["Showing first {n} lines"].replace("{n}", String(PREVIEW_MAX_LINES))}
                    </span>
                )}
            </div>
        );
    }
    if (fetched === "error") {
        return <div className="text-xs opacity-40 select-none">{t["Preview unavailable"]}</div>;
    }
    // Loading (a `read` source still in flight).
    return (
        <div className="flex justify-center py-4 opacity-50">
            <span className="lum-loading"><span/><span/><span/></span>
        </div>
    );
});

export default AttachmentPreview;
