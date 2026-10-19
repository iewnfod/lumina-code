/**
 * MOBILE attachment compression (lib/platform.ts's isMobileApp callers):
 * phone photos inline into the prompt POST as base64 data URIs, and the
 * mobile app uploads them over the frp route (mobile network → nginx →
 * frps → the desktop's frpc → localhost) — a 3–8&nbsp;MB camera image
 * becomes a 4–11&nbsp;MB JSON body that takes ages to push and dies on
 * flaky links. Re-encoding through a canvas caps the longest edge and
 * normalizes to JPEG (which also converts HEIC gallery picks providers
 * can't read). Anything the pipeline can't handle is returned UNCHANGED
 * — compression is an optimization, never a gate on sending.
 *
 * DOM-bound but React-free (the lib/ contract — clipboard.ts precedent);
 * node tests can't load it, so the logic stays deliberately thin.
 */
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";

/** Longest-edge cap for re-encoded images — comfortably above VLM-side
 * downsampling (~1–1.6k), so no readable detail is lost. */
export const COMPRESS_MAX_EDGE = 2048;

/** JPEG quality for the re-encode. */
export const COMPRESS_JPEG_QUALITY = 0.85;

/** Re-encode one image file down to the cap; non-images and undecodable
 * inputs come back untouched, and a result no smaller than the original
 * is discarded in favor of the original. */
export async function compressImageFile(file: File): Promise<File> {
    if (!file.type.startsWith("image/")) return file;
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        // No decoder for this format in this webview (HEIC on some
        // builds, exotic codecs) — the original must still be sendable.
        return file;
    }
    try {
        const scale = Math.min(1, COMPRESS_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return file;
        ctx.drawImage(bitmap, 0, 0, width, height);
        const blob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob(resolve, "image/jpeg", COMPRESS_JPEG_QUALITY);
        });
        if (!blob || blob.size >= file.size) return file;
        logInfo(
            `Compressed image attachment ${file.name}: ${file.size} → ${blob.size} bytes (${width}x${height})`,
        ).catch(() => {});
        return new File([blob], jpegName(file.name), {type: "image/jpeg", lastModified: Date.now()});
    } catch (e) {
        logError(`Image compression failed for ${file.name}, sending original: ${e}`).catch(() => {});
        return file;
    } finally {
        bitmap.close();
    }
}

/** Display name after a JPEG re-encode: swap the extension, keep the
 * stem (the vision divert's note maps ORIGINAL names, so keep it human). */
function jpegName(name: string): string {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    return `${stem || "image"}.jpg`;
}
