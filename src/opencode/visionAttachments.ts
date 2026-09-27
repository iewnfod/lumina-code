import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import {globalConfigTarget} from "./configFiles.ts";
import type {ComposerAttachment, OpencodeModel, SessionModelRef} from "./types.ts";

/**
 * Attachment divert for text-only models (the vision tool's sending
 * half): when the model the prompt is bound for cannot accept images,
 * image attachments are NOT inlined as prompt parts (the provider would
 * drop or reject them) but written to disk under the global config's
 * `attachments/` directory, and a one-line note is appended to the
 * prompt text mapping each image's ORIGINAL name to its saved path —
 * the model reads the note, and the `vision` tool registered by Lumina
 * Code's plugin can inspect the images on its behalf. The note is
 * protocol, not prose: splitAttachmentNote strips it back off for the
 * user bubble, which shows the diverted images as attachment chips
 * instead (and editResend re-appends it so an edited prompt keeps its
 * image paths).
 *
 * Pure planning lives here next to its consumers' domain; the disk
 * write goes through OpencodeApi (the single server-access point).
 */

/**
 * Whether the referenced model accepts image input per the catalog.
 * null = UNKNOWN (model absent from the catalog, e.g. a custom provider
 * entry without capability metadata) — callers treat unknown as
 * "capable" and keep the current inline behavior (zero regression).
 */
export function modelAcceptsImages(
    models: OpencodeModel[],
    ref: SessionModelRef | null,
): boolean | null {
    if (!ref) return null;
    const entry = models.find((m) => m.providerID === ref.providerID && m.modelID === ref.id);
    if (!entry) return null;
    const input = entry.capabilities?.input;
    if (!Array.isArray(input)) return null;
    return input.includes("image");
}

/** The split of staged attachments for one send. */
export interface AttachmentDivertPlan {
    /** Ride the prompt as data-URI parts, unchanged. */
    inline: ComposerAttachment[];
    /** Written to disk; referenced by the note line instead. */
    diverted: ComposerAttachment[];
}

/** Split staged attachments for a model with the given image support:
 * images divert exactly when the model can't take them; every other
 * attachment (files of any kind) always stays inline. */
export function planAttachmentDivert(
    attachments: ComposerAttachment[],
    acceptsImages: boolean | null,
): AttachmentDivertPlan {
    if (acceptsImages !== false || attachments.length === 0) {
        return {inline: attachments, diverted: []};
    }
    return attachments.reduce<AttachmentDivertPlan>(
        (plan, a) => {
            if (a.mime.startsWith("image/")) plan.diverted.push(a);
            else plan.inline.push(a);
            return plan;
        },
        {inline: [], diverted: []},
    );
}

/** A diverted image as the model/UI see it: the ORIGINAL attachment
 * name (CJK intact — the disk name sanitizes it away) plus the path it
 * was written to, so a prompt that says "看看 截图.png" resolves. */
export interface DivertedAttachment {
    name: string;
    path: string;
}

/** The note's fixed head — the generator builds from it and the parser
 * (splitAttachmentNote) locates blocks by it, so the two cannot drift. */
const NOTE_HEAD = "[image attachments saved as files — view them with the vision tool: ";

/** The note appended to the prompt text when attachments were diverted.
 * Written for the MODEL (English, path-forward): the vision tool's
 * description tells it what to do with these paths, and the JSON body
 * maps each image's ORIGINAL name (what the user called it) to its
 * saved file path — an array, so same-named attachments never collide.
 * The user never sees this line: UserBubble strips it back off
 * (splitAttachmentNote) and renders the diverted images as attachment
 * chips instead. */
export function attachmentNoteLine(items: DivertedAttachment[]): string | null {
    if (items.length === 0) return null;
    return `${NOTE_HEAD}${JSON.stringify(items.map(({name, path}) => ({name, path})))}]`;
}

/** Inverse of {@link attachmentNoteLine} over a sent message's text:
 * splits off the TRAILING note block (if any) into the clean text plus
 * the diverted images it carried. Only a note that ENDS the text counts
 * — the send paths append it last, and anything typed after one (a
 * legacy edit) stays visible. Old-format notes (bare comma-joined
 * paths, from before the name mapping) parse too; their display names
 * are recovered from the disk name (divertedDisplayName). */
export function splitAttachmentNote(text: string): {text: string; diverted: DivertedAttachment[] | null} {
    const start = text.lastIndexOf(NOTE_HEAD);
    if (start < 0) return {text, diverted: null};
    const end = text.lastIndexOf("]");
    if (end < start + NOTE_HEAD.length) return {text, diverted: null};
    if (text.slice(end + 1).trim() !== "") return {text, diverted: null};
    const body = text.slice(start + NOTE_HEAD.length, end);
    // Current format: a JSON array of {name, path}.
    try {
        const parsed: unknown = JSON.parse(body);
        if (Array.isArray(parsed)) {
            const items = parsed
                .map((e): DivertedAttachment | null => {
                    const item = e as {name?: unknown; path?: unknown};
                    return typeof item?.name === "string" && typeof item?.path === "string"
                        ? {name: item.name, path: item.path}
                        : null;
                })
                .filter((e): e is DivertedAttachment => e != null);
            if (items.length > 0) return {text: text.slice(0, start).trimEnd(), diverted: items};
        }
    } catch {
        // Not JSON — fall through to the legacy comma-joined format.
    }
    const paths = body.split(", ").map((p) => p.trim()).filter(Boolean);
    if (paths.length === 0) return {text, diverted: null};
    return {
        text: text.slice(0, start).trimEnd(),
        diverted: paths.map((path) => ({name: divertedDisplayName(path), path})),
    };
}

/** Display name for a legacy-format diverted path: attachmentDiskName
 * is `<ts36>-<rand4>-<sanitized name>` — strip the two generated
 * tokens. (CJK names sanitize to "_" there; the current note format
 * carries the original name instead.) */
export function divertedDisplayName(path: string): string {
    const base = path.split("/").pop() ?? path;
    return base.replace(/^[^-]+-[^-]+-/, "") || base;
}

/** Collision-safe disk name for one attachment (same name pasted twice
 * in a row, or across quickly repeated sends). */
export function attachmentDiskName(name: string): string {
    const safe = name.replace(/[^\w.@-]+/g, "_").slice(-64) || "attachment";
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${safe}`;
}

/** Decode a data:…;base64,URI into bytes (atob is available in the
 * webview). null for non-data or non-base64 URIs — the caller keeps
 * such attachments inline rather than losing them. */
export function dataUriToBytes(uri: string): Uint8Array<ArrayBuffer> | null {
    const comma = uri.indexOf(",");
    if (!uri.startsWith("data:") || comma < 0) return null;
    const meta = uri.slice(5, comma);
    if (!meta.endsWith(";base64")) return null;
    try {
        const bin = atob(uri.slice(comma + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    } catch {
        return null;
    }
}

/** Memoized global-config directory (the divert target's parent). The
 * lookup is one cheap local GET; memoizing keeps every send from
 * repeating it, and a failure simply skips the memo. */
let cachedConfigDirectory: string | null = null;

async function configDirectory(api: OpencodeApi): Promise<string | null> {
    if (cachedConfigDirectory) return cachedConfigDirectory;
    try {
        const entries = await api.listConfigEntries();
        const target = globalConfigTarget(entries ?? []);
        if (target) cachedConfigDirectory = target.directory;
    } catch (e) {
        logError(`Failed to locate config directory for attachments: ${e}`).catch(() => {});
    }
    return cachedConfigDirectory;
}

/**
 * The divert for one send: write each diverted attachment under
 * `<global config>/attachments/` and return everything the caller needs
 * to shape the prompt — inline attachments plus the note line to append
 * (null when nothing diverted; the note maps each image's ORIGINAL name
 * to its saved path). A failed write falls back to inlining that
 * attachment (never lose the user's file); the note only names images
 * that actually landed.
 */
export async function divertAttachmentsForSend({
    api,
    attachments,
    acceptsImages,
}: {
    api: OpencodeApi | null;
    attachments: ComposerAttachment[];
    acceptsImages: boolean | null;
}): Promise<{inline: ComposerAttachment[]; note: string | null}> {
    const plan = planAttachmentDivert(attachments, acceptsImages);
    if (plan.diverted.length === 0) return {inline: plan.inline, note: null};
    if (!api) return {inline: attachments, note: null};

    const directory = await configDirectory(api);
    if (!directory) return {inline: attachments, note: null};

    const inline = [...plan.inline];
    const saved: DivertedAttachment[] = [];
    for (const a of plan.diverted) {
        const bytes = dataUriToBytes(a.uri);
        const path = `${directory.replace(/\/+$/, "")}/attachments/${attachmentDiskName(a.name)}`;
        if (!bytes) {
            // Not a decodable data URI — keep it inline rather than drop it.
            inline.push(a);
            continue;
        }
        try {
            await api.writeBinaryFile(path, bytes);
            saved.push({name: a.name, path});
        } catch (e) {
            logError(`Failed to save attachment ${a.name} for the vision tool: ${e}`).catch(() => {});
            inline.push(a);
        }
    }
    if (saved.length > 0) {
        logInfo(`Diverted ${saved.length} image attachment(s) for a text-only model: ${saved.join(", ")}`).catch(() => {});
    }
    return {inline, note: attachmentNoteLine(saved)};
}
