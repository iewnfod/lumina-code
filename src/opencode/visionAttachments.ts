import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import {globalConfigTarget} from "./configFiles.ts";
import type {ComposerAttachment, OpencodeModel, SessionModelRef} from "./types.ts";

/**
 * Attachment divert for text-only models (the vision tool's sending
 * half): when the model the prompt is bound for cannot accept images,
 * image attachments are NOT inlined as prompt parts (the provider would
 * drop or reject them) but written to disk under the global config's
 * `attachments/` directory, and a one-line note pointing at the saved
 * paths is appended to the prompt text — the model reads the note, and
 * the `vision` tool registered by Lumina Code's plugin can inspect the
 * images on its behalf.
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

/** The note appended to the prompt text when attachments were diverted.
 * Written for the MODEL (English, path-forward) — the vision tool's
 * description tells it what to do with these paths; the user sees the
 * same line in their own bubble, so it stays compact. */
export function attachmentNoteLine(paths: string[]): string | null {
    if (paths.length === 0) return null;
    return `[image attachments saved as files — view them with the vision tool: ${paths.join(", ")}]`;
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
 * (null when nothing diverted). A failed write falls back to inlining
 * that attachment (never lose the user's file); the note only names
 * paths that actually landed.
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
    const saved: string[] = [];
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
            saved.push(path);
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
