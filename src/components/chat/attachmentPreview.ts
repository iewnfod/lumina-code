import type {UserMessageFile} from "../../opencode/types.ts";
import {dataUriToBytes, type DivertedAttachment} from "../../opencode/visionAttachments.ts";

/**
 * Pure planning for the user bubble's attachment-chip previews (the
 * clicking-half of AttachmentChips; rendering lives in
 * AttachmentPreview.tsx): which attachments CAN be previewed, and where
 * the preview's bytes come from.
 *
 * Sources follow the chip's own display priority (MessageItem):
 * a data-URI `uri` or `data`+`mime` pair carries the bytes in the
 * message (preview with zero requests), while `file://` mentions and
 * the vision divert's saved paths must be fetched through the server's
 * location-confined fs/read — directory = everything up to the last
 * slash, name = the segment after it (the flat shape the config
 * reads already use; nested names also work, see ChatView's plan-file
 * probe, but a split keeps directory arbitrary).
 *
 * Node-testable (attachmentPreview.test.ts).
 */

/** The previewable kinds. Binary types (pdf, …) preview nothing. */
export type AttachmentPreviewKind = "image" | "text";

/** A server read: fs/read's location + the relative name. */
export interface AttachmentPreviewRead {
    directory: string;
    name: string;
}

/** Everything the preview component needs for one chip, resolved
 * WITHOUT React: ready sources carry their payload inline, `read`
 * sources name the file to fetch. */
export type AttachmentPreviewSource =
    | {kind: "image"; name: string; src: string}
    | {kind: "text"; name: string; content: string}
    | {kind: AttachmentPreviewKind; name: string; read: AttachmentPreviewRead};

/** Image extensions the webview can actually decode (heic &co. can't —
 *  they stay inert rather than rendering a broken box). */
const IMAGE_EXT = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
]);

/** Text/code extensions — the fallback when the mime is absent or
 *  generic (FileReader's readAsDataURL often yields an EMPTY mime for
 *  source files, so the name decides). */
const TEXT_EXT = new Set([
    "txt", "md", "markdown", "json", "jsonc", "json5", "yaml", "yml",
    "toml", "ini", "cfg", "conf", "env", "properties", "log",
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
    "py", "pyi", "rs", "go", "java", "kt", "kts",
    "c", "h", "cpp", "hpp", "cc", "hh", "cs", "rb", "php",
    "swift", "m", "mm", "sql",
    "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "astro",
    "xml", "graphql", "gql", "tf", "tfvars", "hcl",
    "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
    "dockerfile", "makefile", "mk", "cmake", "gradle", "lock",
]);

/** mime types that are textual despite an application/ prefix. */
const APP_TEXT_MIME = new Set([
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/x-sh",
    "application/x-yaml",
    "application/yaml",
    "application/toml",
]);

function extensionOf(name: string): string {
    const base = name.split("/").pop() ?? name;
    const dot = base.lastIndexOf(".");
    if (dot <= 0) return ""; // no extension, or a dotfile like ".gitignore"
    return base.slice(dot + 1).toLowerCase();
}

/** Whether one attachment is previewable, and how: mime wins, the file
 *  name's extension is the fallback (an absent/empty mime is normal for
 *  staged files). null = not previewable (chip stays inert). */
export function previewKind(name: string | undefined, mime: string | undefined): AttachmentPreviewKind | null {
    const m = (mime ?? "").split(";")[0].trim().toLowerCase();
    if (m.startsWith("image/")) return "image";
    if (m.startsWith("text/")) return "text";
    if (APP_TEXT_MIME.has(m) || m.endsWith("+xml") || m.endsWith("+json")) return "text";
    const ext = extensionOf(name ?? "");
    if (IMAGE_EXT.has(ext)) return "image";
    if (TEXT_EXT.has(ext)) return "text";
    return null;
}

/** Split an absolute path (or a `file://` URI) into fs/read's location
 * + relative name — the flat read shape the config editor uses. null
 * when there is no slash or the name segment is empty. */
export function splitFilePath(path: string): AttachmentPreviewRead | null {
    let p = path;
    if (p.startsWith("file://")) p = p.slice("file://".length);
    const slash = p.lastIndexOf("/");
    if (slash < 0) return null;
    const name = p.slice(slash + 1);
    if (name === "") return null;
    return {directory: slash === 0 ? "/" : p.slice(0, slash), name};
}

/** Decode a base64 data URI into utf-8 text; null when it isn't a
 *  decodable base64 data URI (the caller drops the preview rather than
 *  show garbage). */
export function dataUriText(uri: string): string | null {
    const bytes = dataUriToBytes(uri);
    if (bytes == null) return null;
    return new TextDecoder().decode(bytes);
}

/** Resolve one inline message attachment (`UserMessageFile`) to its
 *  preview source, or null when it can't be previewed. */
export function inlineFilePreviewSource(f: UserMessageFile): AttachmentPreviewSource | null {
    const name = typeof f.name === "string" ? f.name : "";
    const mime = typeof f.mime === "string" ? f.mime : undefined;
    const kind = previewKind(name, mime);
    if (kind == null) return null;
    const uri = typeof f.uri === "string" && f.uri !== ""
        ? f.uri
        : typeof f.data === "string" && mime
            ? `data:${mime};base64,${f.data}`
            : null;
    if (uri == null) {
        // No inline bytes and no path to read from.
        return null;
    }
    if (uri.startsWith("data:")) {
        if (kind === "image") return {kind, name, src: uri};
        const content = dataUriText(uri);
        return content == null ? null : {kind, name, content};
    }
    const read = splitFilePath(uri);
    return read == null ? null : {kind, name, read};
}

/** Resolve one vision-diverted attachment (image saved to disk for a
 *  text-only model) — always an image, read from its saved path. */
export function divertedPreviewSource(d: DivertedAttachment): AttachmentPreviewSource | null {
    const read = splitFilePath(d.path);
    return read == null ? null : {kind: "image", name: d.name, read};
}

/** One attachment chip's full render+preview data — the single shape
 *  MessageItem's chip row and its preview resolution share, so the
 *  chip keys can never drift from what the panel resolves. */
export interface AttachmentChipItem {
    key: string;
    name: string;
    /** Inline thumbnail source when the bytes ride the message (data
     *  URI); null → the file-type icon. */
    thumb: string | null;
    /** Whether {@link thumb} renders as an image (mime-checked, the
     *  chip row's existing rule). */
    isImageThumb: boolean;
    /** Saved path for diverted attachments (the chip's hover hint). */
    path?: string;
    /** The preview source; null = the chip stays inert. */
    source: AttachmentPreviewSource | null;
}

/** Build the chip items for one user message's attachments: inline
 *  `files` (keyed by index) followed by vision-diverted images (keyed
 *  by saved path). */
export function attachmentChips(
    files: UserMessageFile[],
    diverted: DivertedAttachment[] | null | undefined,
): AttachmentChipItem[] {
    const items: AttachmentChipItem[] = [];
    files.forEach((f, i) => {
        const name = typeof f.name === "string" && f.name !== "" ? f.name : "file";
        const uri = typeof f.uri === "string" && f.uri !== "" ? f.uri : null;
        const fromData = typeof f.data === "string" && typeof f.mime === "string"
            ? `data:${f.mime};base64,${f.data}`
            : null;
        const thumb = uri ?? fromData;
        items.push({
            key: `file:${i}`,
            name,
            thumb,
            isImageThumb: (f.mime ?? "").startsWith("image/") && thumb != null,
            source: inlineFilePreviewSource(f),
        });
    });
    (diverted ?? []).forEach((d) => {
        items.push({
            key: `divert:${d.path}`,
            name: d.name,
            thumb: null,
            isImageThumb: false,
            path: d.path,
            source: divertedPreviewSource(d),
        });
    });
    return items;
}


/** Line cap for text previews — keeps a giant file from mounting a
 *  diff row per line; the UI notes the truncation. */
export const PREVIEW_MAX_LINES = 2000;

/** Split preview text into (at most {@link PREVIEW_MAX_LINES}) lines,
 *  CRLF-normalized, flagging whether anything was cut. */
export function capPreviewLines(text: string, max = PREVIEW_MAX_LINES): {lines: string[]; truncated: boolean} {
    const all = text.split(/\r?\n/);
    if (all.length <= max) return {lines: all, truncated: false};
    return {lines: all.slice(0, max), truncated: true};
}
