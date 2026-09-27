import type {ChatUserMessage, ComposerAttachment} from "../../opencode/types.ts";

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

/** Rebuild staged attachments from a sent message's files (edit mode):
 * a stored `uri` rides along as-is, inlined base64 (`data` + `mime`) is
 * re-wrapped as a data: URI; files carrying neither are dropped. `size`
 * is not recoverable and only feeds the read path's id/cap check — 0. */
export function filesFromMessage(message: ChatUserMessage): ComposerAttachment[] {
    return (message.files ?? [])
        .map((f, i) => ({
            id: `${message.id}:${i}`,
            name: f.name ?? "file",
            mime: f.mime ?? "",
            size: 0,
            uri:
                typeof f.uri === "string"
                    ? f.uri
                    : f.data != null && f.mime != null
                      ? `data:${f.mime};base64,${f.data}`
                      : "",
        }))
        .filter((a) => a.uri !== "");
}
