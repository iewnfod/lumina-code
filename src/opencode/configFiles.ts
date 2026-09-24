import type {OpencodeConfigEntry} from "./types.ts";

/**
 * Where the global opencode.json lives, derived from `GET /api/config`
 * (entries are ordered lowest → highest priority; the FIRST entry is
 * always the global location). Pure — the read/write I/O stays in
 * OpencodeApi. Shared by the settings config editor (modelConfig.ts)
 * and the attachment divert (visionAttachments.ts).
 */

export interface GlobalConfigTarget {
    directory: string;
    file: string;
    /** A document we must not machine-rewrite (comments would die). */
    jsonc: boolean;
}

export function globalConfigTarget(entries: OpencodeConfigEntry[]): GlobalConfigTarget | null {
    const first = entries[0];
    if (!first) return null;
    if (first.type === "document") {
        const dir = first.path.split("/").slice(0, -1).join("/");
        return {directory: dir, file: first.path, jsonc: !first.path.endsWith(".json")};
    }
    const dir = first.path.replace(/\/+$/, "");
    return {directory: dir, file: `${dir}/opencode.json`, jsonc: false};
}
