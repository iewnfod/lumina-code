import type {ComposerAttachment} from "../../opencode/types.ts";

/** Hard cap per attachment — data URIs ride inside the prompt JSON. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Read one file into a data-URI attachment (size-capped; null when the
 *  file is too large or unreadable). */
export function readAttachment(file: File): Promise<ComposerAttachment | null> {
    if (file.size > MAX_ATTACHMENT_BYTES) return Promise.resolve(null);
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
            resolve({
                id: `${file.name}:${file.size}:${file.lastModified}`,
                name: file.name,
                mime: file.type || "application/octet-stream",
                size: file.size,
                uri: String(reader.result ?? ""),
            });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}
