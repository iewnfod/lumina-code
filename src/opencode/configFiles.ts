import type {OpencodeApi} from "./api/index.ts";
import type {OpencodeConfigEntry} from "./types.ts";

/**
 * Where the global opencode.json lives, derived from `GET /api/config`
 * (entries are ordered lowest → highest priority; the FIRST entry is
 * always the global location). The discovery half is pure; the one api
 * bound helper below is the shared discovery+read step every server
 * config editor repeats. Shared by the settings config editors
 * (ModelSettings / SystemPromptSection) and the attachment divert
 * (visionAttachments.ts).
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

/** The global config document, discovered AND read in one step — the
 *  chain every server-config editor hand-rolled before (listConfigEntries
 *  → globalConfigTarget → file name → readTextFile). Returns null when
 *  the server lists no config location; `text` is null when the document
 *  is absent and "" when it exists but is empty. Read failures THROW —
 *  callers own their degrade path (a failed read must never read as
 *  "absent"; rewriting on that assumption would clobber a config we
 *  failed to read). node-testable via a fake api. */
export async function readGlobalConfig(
    api: OpencodeApi,
): Promise<{target: GlobalConfigTarget; text: string | null} | null> {
    const entries = await api.listConfigEntries();
    const target = globalConfigTarget(entries ?? []);
    if (!target) return null;
    const name = target.file.split("/").pop() ?? "opencode.json";
    const text = await api.readTextFile(target.directory, name);
    return {target, text};
}
