import {ApiTransport, UPLOAD_TIMEOUT_MS} from "./transport.ts";

/**
 * The FS domain of the opencode REST client — the location-confined
 * read pair (text + bytes) and the absolute-path write pair over
 * `experimental/fs`. Verified against server v2.0.11.
 */
export interface FsApi {
    readTextFile(directory: string, name: string): Promise<string | null>;
    readFileBlob(directory: string, name: string): Promise<Blob | null>;
    writeTextFile(absolutePath: string, content: string): Promise<void>;
    writeBinaryFile(absolutePath: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
}

/** Shared 404→null tolerance of the fs/read pair: absent files read as
 *  null; every other failure rethrows. Callers MUST NOT treat a failed
 *  read as "absent" — rewriting on that assumption would clobber a
 *  config we failed to read. */
async function readOrNull<T>(run: () => Promise<T>): Promise<T | null> {
    try {
        return await run();
    } catch (e) {
        if ((e as {status?: number}).status === 404) return null;
        throw e;
    }
}

/** The fs domain methods (see the interface); composed onto the
 *  OpencodeApi prototype in index.ts. */
export const fsApi: FsApi & ThisType<ApiTransport> = {
    /** Read one file as text, relative to a directory (fs/read is confined
     *  to the location — unlike fs/write). Returns null when the file
     *  doesn't exist (404); other failures throw. Callers MUST NOT treat
     *  a failed read as "absent" — rewriting on that assumption would
     *  clobber a config we failed to read. v2.0.11 quirk: a directory
     *  that doesn't exist yet yields 500, NOT 404 (first-save flows must
     *  catch and treat as absent themselves — see ToolsTab). */
    async readTextFile(directory: string, name: string): Promise<string | null> {
        const path = `/api/fs/read/${encodeURIComponent(name)}${this.locationQuery(directory)}`;
        return readOrNull(() => this.requestRawText(path));
    },

    /** Binary twin of {@link readTextFile} (same location-confined
     *  fs/read): one file's raw bytes as a Blob — attachment previews
     *  (diverted images, file:// mentions). Returns null on 404; other
     *  failures throw. Server quirk (per the v2 SDK schema): fs/read
     *  answers with the file's bytes (200: Blob | File), not a JSON
     *  envelope. */
    async readFileBlob(directory: string, name: string): Promise<Blob | null> {
        const path = `/api/fs/read/${encodeURIComponent(name)}${this.locationQuery(directory)}`;
        return readOrNull(() => this.requestRawBlob(path));
    },

    /** Write text to an ABSOLUTE path (experimental fs/write is not
     *  location-confined; missing parent directories are created).
     *  Server quirk: the endpoint REJECTS `Content-Type: application/json`
     *  with 415 — the body must ride as octet-stream (verified v2.0.11). */
    writeTextFile(absolutePath: string, content: string): Promise<void> {
        const params = new URLSearchParams({path: absolutePath});
        return this.request<void>(`/api/experimental/fs/write?${params.toString()}`, {
            method: "POST",
            headers: {"Content-Type": "application/octet-stream"},
            body: content,
        });
    },

    /** Binary twin of {@link writeTextFile} for raw bytes (image
     *  attachments diverted for the vision tool) — same octet-stream
     *  fs/write endpoint, deadline-bounded like the prompt POST (same
     *  mobile-route rationale). */
    writeBinaryFile(absolutePath: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        const params = new URLSearchParams({path: absolutePath});
        return this.request<void>(`/api/experimental/fs/write?${params.toString()}`, {
            method: "POST",
            headers: {"Content-Type": "application/octet-stream"},
            body: new Blob([bytes]),
        }, UPLOAD_TIMEOUT_MS);
    }
};
