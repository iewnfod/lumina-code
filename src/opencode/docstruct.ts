/**
 * The frontend half of the office-tools plugin's structure SIDECAR
 * (src/plugins/officeTools.js writes it next to every generated
 * document; DocumentPreviewModal renders it). This module is the
 * contract's TS mirror — the PLUGIN FILE stays the wire authority (it
 * cannot import from src/, so the two are anchored by this comment):
 *
 *   <workspace>/.lumina/docstruct/<fileName>.json
 *   {version: 1, source: "office-tools", file, format, size,
 *    generatedAt, blocks? | slides?}
 *
 * `size` is the written file's byte count — the preview's staleness
 * signal (the user may have edited the document in Word since). Parsing
 * is deliberately LENIENT: an unknown block type renders as nothing
 * (forward compatibility with a newer plugin), and anything malformed
 * reads as "no sidecar" (the preview degrades to the system app).
 *
 * node-testable (docstruct.test.ts).
 */

// --- Block protocol (docx) ---------------------------------------------------

export interface DocstructHeading {
    type: "heading";
    level: 1 | 2 | 3;
    text: string;
}

export interface DocstructParagraph {
    type: "paragraph";
    text: string;
    bold?: true;
    italic?: true;
}

export interface DocstructList {
    type: "list";
    ordered: boolean;
    items: string[];
}

export interface DocstructTable {
    type: "table";
    header?: string[];
    rows: string[][];
}

export interface DocstructImage {
    type: "image";
    /** Source image path — absolute, or relative to the workspace. */
    path: string;
    caption?: string;
}

export type DocstructBlock =
    | DocstructHeading
    | DocstructParagraph
    | DocstructList
    | DocstructTable
    | DocstructImage;

// --- Slide protocol (pptx) ----------------------------------------------------

export type DocstructSlideLayout = "title" | "titleContent" | "twoContent" | "blank";

export interface DocstructBullet {
    text: string;
    level: 0 | 1;
}

export interface DocstructSlide {
    layout: DocstructSlideLayout;
    title?: string;
    subtitle?: string;
    bullets?: DocstructBullet[];
    /** Source image path — absolute, or relative to the workspace. */
    image?: string;
    notes?: string;
}

// --- The sidecar itself --------------------------------------------------------

export interface Docstruct {
    version: 1;
    source: "office-tools";
    file: string;
    format: "docx" | "pptx";
    /** Byte count of the written file at generation time (staleness). */
    size: number;
    generatedAt: string;
    blocks?: DocstructBlock[];
    slides?: DocstructSlide[];
}

const OFFICE_EXTENSIONS = new Set(["docx", "pptx"]);

/** Whether a path is an office document the preview handles
 * (case-insensitive extension check). */
export function isOfficeDocument(path: string): boolean {
    const base = path.split("/").pop() ?? path;
    const dot = base.lastIndexOf(".");
    if (dot <= 0) return false;
    return OFFICE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** The sidecar's location for a document in a workspace directory — the
 * same join the plugin performs (full file name + .json, so a same-stem
 * docx/pptx pair never collides). */
export function docstructSidecarPath(directory: string, fileName: string): string {
    return `${directory.replace(/\/+$/, "")}/.lumina/docstruct/${fileName}.json`;
}

/** Lenient parse of a sidecar's raw text: null for anything malformed,
 * a wrong version, a foreign source, or a missing blocks/slides array —
 * callers treat null as "no preview available". Unknown block TYPES are
 * KEPT (the renderer skips them) so a newer plugin's sidecar still
 * previews its known parts. */
export function parseDocstruct(raw: string): Docstruct | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const d = parsed as Record<string, unknown>;
    if (d.version !== 1) return null;
    if (d.source !== "office-tools") return null;
    if (typeof d.file !== "string" || d.file === "") return null;
    if (d.format !== "docx" && d.format !== "pptx") return null;
    if (typeof d.size !== "number" || !Number.isFinite(d.size) || d.size <= 0) return null;
    if (typeof d.generatedAt !== "string") return null;
    const hasBlocks = Array.isArray(d.blocks);
    const hasSlides = Array.isArray(d.slides);
    if (!hasBlocks && !hasSlides) return null;
    // Shallow shape checks only — depth belongs to the renderer, which
    // skips anything it does not recognize.
    if (hasBlocks && (d.blocks as unknown[]).some((b) => b === null || typeof b !== "object")) return null;
    if (hasSlides && (d.slides as unknown[]).some((s) => s === null || typeof s !== "object")) return null;
    return parsed as Docstruct;
}

/** Whether a sidecar no longer matches its document on disk (the file's
 * CURRENT byte count vs the recorded one — the user edited it in
 * Word/WPS since it was generated). Unknown size (0/negative) reads as
 * fresh; a stale preview still renders, behind its warning banner. */
export function docstructStale(doc: Docstruct, currentSize: number): boolean {
    if (!Number.isFinite(currentSize) || currentSize <= 0) return false;
    return Math.floor(currentSize) !== doc.size;
}
