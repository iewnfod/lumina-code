import {memo, useEffect, useMemo, useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
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
    // Whole file as context rows: numbered, highlighted, no diff wash.
    const hunks = useMemo(
        () => lines.length > 0 && !(lines.length === 1 && lines[0] === "")
            ? fragmentHunks(lines.map((text) => ({kind: "same" as const, text})), source.name)
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
            <div className="flex justify-center">
                <img
                    src={imageSrc}
                    alt={source.name}
                    className="max-h-[55vh] rounded-[var(--radius-lg)]"
                    style={{border: `1px solid ${colors.glassBorder}`}}
                />
            </div>
        );
    }
    if (textContent != null) {
        return (
            <div className="flex flex-col gap-1">
                {/* The workspace display's recessed reading surface (the
                    stats panel's BodyBox shape, ToolCard's box pattern). */}
                <div
                    className="rounded-[var(--radius-sm)] max-h-[55vh] overflow-auto px-3 py-2"
                    style={{background: colors.recessedBg}}
                >
                    {hunks.length > 0
                        ? <DiffViewBody hunks={hunks} fileName={source.name}/>
                        : <span className="opacity-40 text-sm select-none">{t["Preview unavailable"]}</span>}
                </div>
                {truncated && (
                    <span className="text-[11px] opacity-40 select-none">
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
