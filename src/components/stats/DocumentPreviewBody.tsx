import {memo, useEffect, useMemo, useState} from "react";
import {ExternalLink, FolderOpen} from "lucide-react";
import {openPath, revealItemInDir} from "@tauri-apps/plugin-opener";
import {warn} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {
    docstructSidecarPath,
    docstructStale,
    parseDocstruct,
    type Docstruct,
    type DocstructBlock,
} from "../../opencode/docstruct.ts";
import type {DocRow} from "../../opencode/workspaceDocuments.ts";
import {splitFilePath} from "../chat/attachmentPreview.ts";
import IconButton from "../ui/IconButton.tsx";
import Hint from "../ui/Hint.tsx";
import {BodyBox} from "./statsChrome.tsx";

/**
 * The DAILY side's document-preview DRILL BODY (the office-tools plugin's
 * structure sidecar rendered back): clicking an office row in
 * DocumentsSection aims the workspace-activity panel here — the same
 * drill model as FileDiffBody / TerminalBody / SubagentBody (overview →
 * detail, back button in the panel header).
 *
 * Rendering is the SIDECAR's structure, not the file's layout: a docx
 * renders as a paper-width document flow (headings/paragraphs/lists/
 * tables/embedded images), a pptx as one 16:9 card per slide. Fidelity
 * is "what the document says", not "how Word paginates it" — the
 * toolbar's system-app buttons cover the real look. Documents without a
 * sidecar (user's own, foreign) say so and offer the system app instead;
 * a size mismatch (edited in Word since generation) shows a staleness
 * banner but still renders.
 */

/** Resolve one sidecar image path (absolute or workspace-relative) into
 * fs/read's directory + name pair; null when it cannot be split. */
function imageReadTarget(path: string, workspaceDir: string): {directory: string; name: string} | null {
    if (path.startsWith("/")) return splitFilePath(path);
    return {directory: workspaceDir, name: path};
}

/** Collect every image path a sidecar references (docx blocks + pptx
 * slides) — the component preloads them all into blob URLs. Pure. */
export function sidecarImagePaths(doc: Docstruct): string[] {
    const paths: string[] = [];
    for (const block of doc.blocks ?? []) {
        if (block.type === "image") paths.push(block.path);
    }
    for (const slide of doc.slides ?? []) {
        if (slide.image) paths.push(slide.image);
    }
    return paths;
}

type LoadState =
    | {phase: "loading"}
    | {phase: "no-sidecar"}
    | {phase: "ready"; doc: Docstruct};

const DocumentPreviewBody = memo(function DocumentPreviewBody({
    row,
    directory,
}: {
    /** The document row being previewed — the panel resolves it LIVE so a
     * refreshed scan's byte count flows into the staleness check. */
    row: DocRow;
    /** The workspace directory (sidecar location + relative image base). */
    directory: string | null;
}) {
    const t = useI18n();
    const colors = useColors();
    const {api} = useConnection();
    const [state, setState] = useState<LoadState>({phase: "loading"});
    const fileName = row.path.split("/").pop() ?? row.path;

    // (Re)load the sidecar for the row being shown.
    useEffect(() => {
        let cancelled = false;
        setState({phase: "loading"});
        (async () => {
            if (!api || !directory) {
                if (!cancelled) setState({phase: "no-sidecar"});
                return;
            }
            try {
                // The sidecar's location derives through the shared join
                // (docstructSidecarPath) — one definition with the plugin's
                // writer — then splits back into fs/read's flat pair.
                const target = splitFilePath(docstructSidecarPath(directory, fileName));
                if (!target) {
                    if (!cancelled) setState({phase: "no-sidecar"});
                    return;
                }
                const raw = await api.readTextFile(target.directory, target.name);
                const doc = raw === null ? null : parseDocstruct(raw);
                if (!cancelled) setState(doc ? {phase: "ready", doc} : {phase: "no-sidecar"});
            } catch (e) {
                warn(`Document sidecar read failed for ${fileName}: ${e}`).catch(() => {});
                if (!cancelled) setState({phase: "no-sidecar"});
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [api, directory, fileName]);

    const doc = state.phase === "ready" ? state.doc : null;

    // Embedded images: blob URLs per sidecar path (the AttachmentPreview
    // lifecycle — object URLs revoked on swap/unmount).
    const imagePaths = useMemo(() => (doc ? sidecarImagePaths(doc) : []), [doc]);
    const [images, setImages] = useState<Map<string, string>>(new Map());
    useEffect(() => {
        if (!doc || !api || !directory || imagePaths.length === 0) {
            setImages(new Map());
            return;
        }
        let cancelled = false;
        const created: string[] = [];
        (async () => {
            const next = new Map<string, string>();
            for (const path of imagePaths) {
                const target = imageReadTarget(path, directory);
                if (!target) continue;
                try {
                    const blob = await api.readFileBlob(target.directory, target.name);
                    if (blob == null) continue;
                    const url = URL.createObjectURL(blob);
                    created.push(url);
                    next.set(path, url);
                } catch {
                    // one unreadable image never blocks the preview
                }
            }
            if (!cancelled) setImages(next);
        })();
        return () => {
            cancelled = true;
            for (const url of created) URL.revokeObjectURL(url);
        };
    }, [doc, api, directory, imagePaths]);

    // Unknown size (a drill arriving before the scan, size 0) reads as
    // fresh — the panel's live row resolution fills the real count in.
    const stale = doc !== null && docstructStale(doc, row.size);

    const openExternally = () => {
        openPath(row.path).catch((e) => {
            warn(`Failed to open ${row.path}: ${e}`).catch(() => {});
        });
    };

    return (
        <BodyBox fill className="flex flex-col">
            {/* Action row: leave the app only on purpose (the panel header
             * owns the back/collapse chrome). */}
            <div className="flex items-center justify-end gap-1 px-2 pt-1.5 pb-1 shrink-0">
                <Hint label={t["Open in system app"]}>
                    <IconButton
                        size={22}
                        circle
                        hoverOverlay={colors.hoverOverlay}
                        activeOverlay={colors.activeOverlay}
                        aria-label={t["Open in system app"]}
                        onClick={openExternally}
                    >
                        <ExternalLink size={12}/>
                    </IconButton>
                </Hint>
                <Hint label={t["Show in folder"]}>
                    <IconButton
                        size={22}
                        circle
                        hoverOverlay={colors.hoverOverlay}
                        activeOverlay={colors.activeOverlay}
                        aria-label={t["Show in folder"]}
                        onClick={() => {
                            revealItemInDir(row.path).catch((e) => {
                                warn(`Failed to reveal ${row.path}: ${e}`).catch(() => {});
                            });
                        }}
                    >
                        <FolderOpen size={12}/>
                    </IconButton>
                </Hint>
            </div>

            {stale && (
                <div className="mx-2 mb-1.5 px-2 py-1 rounded-[var(--radius-xs)] text-2xs select-none shrink-0"
                    style={{background: "var(--color-warning)", color: "#fff"}}>
                    {t["This document was modified outside the app — preview may be outdated"]}
                </div>
            )}

            {state.phase === "loading" && (
                <div className="flex justify-center py-8 opacity-50">
                    <span className="lum-loading"><span/><span/><span/></span>
                </div>
            )}
            {state.phase === "no-sidecar" && (
                <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
                    <p className="text-xs opacity-50 select-none">{t["No in-app preview — this document was not generated here"]}</p>
                    <button
                        type="button"
                        className="text-xs px-3 py-1.5 rounded-[var(--radius-sm)] lum-wash"
                        style={{background: colors.activeOverlay, color: colors.textPrimary}}
                        onClick={openExternally}
                    >
                        {t["Open in system app"]}
                    </button>
                </div>
            )}
            {doc && (
                <div className="lum-enter min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                    {doc.format === "docx"
                        ? <WordPaper blocks={doc.blocks ?? []} images={images}/>
                        : <SlideDeck slides={doc.slides ?? []} images={images}/>}
                </div>
            )}
        </BodyBox>
    );
});

// --- Word rendering -----------------------------------------------------------

/** The paper: a white page-like column, dark text on white regardless of
 * the app theme (a document IS paper — the theme owns the chrome around
 * it). Width capped to a comfortable reading measure. */
function WordPaper({blocks, images}: {blocks: DocstructBlock[]; images: Map<string, string>}) {
    return (
        <div
            className="mx-auto w-full max-w-[560px] rounded-[var(--radius-sm)] px-8 py-7 mb-3"
            style={{background: "#ffffff", color: "#1f2328", boxShadow: "0 1px 8px rgba(0,0,0,0.15)"}}
        >
            {blocks.map((block, i) => (
                <WordBlock key={i} block={block} images={images}/>
            ))}
        </div>
    );
}

function WordBlock({block, images}: {block: DocstructBlock; images: Map<string, string>}) {
    switch (block.type) {
        case "heading": {
            const size = block.level === 1 ? "text-[19px]" : block.level === 2 ? "text-[15px]" : "text-[13.5px]";
            return (
                <p className={`${size} font-bold leading-snug mt-4 mb-1.5 first:mt-0`} style={{color: "#111418"}}>
                    {block.text}
                </p>
            );
        }
        case "paragraph":
            return (
                <p className="text-[12.5px] leading-[1.7] my-1.5"
                    style={{fontWeight: block.bold ? 600 : undefined, fontStyle: block.italic ? "italic" : undefined}}>
                    {block.text}
                </p>
            );
        case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
                <ListTag className={`text-[12.5px] leading-[1.7] my-1.5 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
                    {block.items.map((item, i) => <li key={i} className="my-0.5">{item}</li>)}
                </ListTag>
            );
        }
        case "table": {
            const header = block.header ?? null;
            return (
                <div className="my-2.5 overflow-x-auto">
                    <table className="w-full text-[11.5px] border-collapse">
                        <tbody>
                            {header && (
                                <tr>
                                    {header.map((cell, i) => (
                                        <th key={i} className="border px-1.5 py-1 text-left font-semibold"
                                            style={{borderColor: "#d0d7de"}}>{cell}</th>
                                    ))}
                                </tr>
                            )}
                            {block.rows.map((row, r) => (
                                <tr key={r}>
                                    {row.map((cell, c) => (
                                        <td key={c} className="border px-1.5 py-1 align-top"
                                            style={{borderColor: "#d0d7de"}}>{cell}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
        }
        case "image": {
            const url = images.get(block.path);
            return (
                <figure className="my-3 flex flex-col items-center gap-1.5">
                    {url != null
                        ? <img src={url} alt={block.caption ?? ""} className="max-w-full rounded-[var(--radius-xs)]"/>
                        : <div className="w-full h-14 rounded-[var(--radius-xs)] flex items-center justify-center text-2xs"
                            style={{background: "#f0f2f4", color: "#8b949e"}}>[image]</div>}
                    {block.caption && (
                        <figcaption className="text-[10.5px]" style={{color: "#6e7781"}}>{block.caption}</figcaption>
                    )}
                </figure>
            );
        }
        default:
            // Forward compatibility: a newer plugin's unknown block
            // renders as nothing rather than breaking the preview.
            return null;
    }
}

// --- PPT rendering --------------------------------------------------------------

function SlideDeck({slides, images}: {slides: NonNullable<Docstruct["slides"]>; images: Map<string, string>}) {
    return (
        <div className="flex flex-col gap-3 mb-3">
            {slides.map((slide, i) => (
                <SlideCard key={i} index={i + 1} total={slides.length} slide={slide} images={images}/>
            ))}
        </div>
    );
}

function SlideCard({
    index,
    total,
    slide,
    images,
}: {
    index: number;
    total: number;
    slide: NonNullable<Docstruct["slides"]>[number];
    images: Map<string, string>;
}) {
    const imageUrl = slide.image ? images.get(slide.image) : undefined;
    return (
        <div
            className="rounded-[var(--radius-sm)] overflow-hidden relative"
            style={{background: "#ffffff", color: "#1f2328", boxShadow: "0 1px 6px rgba(0,0,0,0.14)"}}
        >
            <div className="aspect-video flex flex-col p-[5%]">
                {slide.title && (
                    <p className={`font-bold leading-tight ${slide.layout === "title" ? "text-[clamp(15px,2.8vw,22px)] mt-[8%] mb-1.5 text-center" : "text-[clamp(12px,1.8vw,16px)] mb-[3%]"}`}
                        style={{color: "#111418"}}>
                        {slide.title}
                    </p>
                )}
                {slide.subtitle && (
                    <p className={`text-[clamp(10px,1.4vw,12.5px)] ${slide.layout === "title" ? "text-center opacity-70" : "opacity-70"} mb-1.5`}>
                        {slide.subtitle}
                    </p>
                )}
                {slide.bullets && slide.bullets.length > 0 && (
                    <ul className={`text-[clamp(9.5px,1.35vw,12px)] leading-[1.55] space-y-1 ${slide.layout === "title" ? "text-center" : ""}`}>
                        {slide.bullets.map((bullet, i) => (
                            <li key={i} className="flex gap-2" style={{paddingLeft: bullet.level * 14}}>
                                <span aria-hidden className="shrink-0 opacity-60">•</span>
                                <span className="min-w-0">{bullet.text}</span>
                            </li>
                        ))}
                    </ul>
                )}
                {imageUrl != null && (
                    <div className="flex-1 min-h-0 flex items-center justify-center mt-1.5">
                        <img src={imageUrl} alt="" className="max-w-full max-h-full object-contain rounded-[var(--radius-xs)]"/>
                    </div>
                )}
            </div>
            {/* Page number chip. */}
            <span className="absolute bottom-1 right-2 text-[9px] tabular-nums select-none" style={{color: "#8b949e"}}>
                {index} / {total}
            </span>
            {slide.notes && (
                <div className="px-[5%] py-1 text-[10px] border-t"
                    style={{borderColor: "#eaeef2", color: "#6e7781", background: "#f8f9fb"}}>
                    {slide.notes}
                </div>
            )}
        </div>
    );
}

export default DocumentPreviewBody;
