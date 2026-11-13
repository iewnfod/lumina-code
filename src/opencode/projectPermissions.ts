import {parseRoot, serializeConfigWrite} from "./pluginConfigShared.ts";
import {
    applyPermissionMode,
    identifyPermissionMode,
    manualRuleCount,
    type PermissionModeId,
} from "./permissionModes.ts";
import type {PermissionRule} from "./types.ts";

/**
 * THE PROJECT-SIDE half of the permission-mode picker: where a directory's
 * opencode config lives, what its `permissions` array currently expresses,
 * and the read→merge→write that switches modes.
 *
 * Document choice (spike-verified server v2.0.11): config discovery walks
 * the Location directory and every ancestor, merging project documents
 * BEFORE agent-section rules (spike: our rules land after the built-in base
 * policy and built-in agent add-ons, so last-match-wins makes the
 * fingerprint decisive) — writing the directory's own document is always
 * correct and never touches other files. An existing document wins over
 * creating one; a fresh directory gets `.opencode/opencode.json` (the
 * tool-private location — nothing dumped into the project root).
 *
 * JSONC documents are READ-ONLY to us (machine-rewriting would kill the
 * comments — the pluginsMcp refusal pattern): identification still works
 * when the text happens to be strict JSON, writes refuse with `jsonc`.
 *
 * Every write runs inside serializeConfigWrite (the shared config write
 * lock) so a double-click can't interleave two read→merge→write batches.
 */

/** The fs surface this module needs (satisfied by OpencodeApi) — keeps the
 * node tests fake-able. */
export interface ProjectFsApi {
    /** 404 (and the 500-missing-directory quirk, handled here) read as
     * null; other failures throw — see {@link locateProjectConfig}. */
    readTextFile(directory: string, name: string): Promise<string | null>;
    writeTextFile(absolutePath: string, content: string): Promise<void>;
}

/** Candidate documents, most-preferred first (an existing one wins; a
 * fresh directory gets the `.opencode` tool-private file). */
export function configCandidates(directory: string): {file: string; jsonc: boolean}[] {
    const dir = directory.replace(/\/+$/, "");
    return [
        {file: `${dir}/opencode.json`, jsonc: false},
        {file: `${dir}/opencode.jsonc`, jsonc: true},
        {file: `${dir}/.opencode/opencode.json`, jsonc: false},
        {file: `${dir}/.opencode/opencode.jsonc`, jsonc: true},
    ];
}

export interface ProjectConfigTarget {
    /** Absolute file path — the write target. */
    file: string;
    /** Comment-bearing document: machine writes refused. */
    jsonc: boolean;
    /** false = nothing exists yet; this is the file we would create. */
    existed: boolean;
}

/** The `permissions` array as-is (members cast — odd-shaped entries pass
 * through untouched on rewrite), or null when the section exists but isn't
 * an array (malformed: refuse to touch). A missing section is []. */
export function extractPermissionRules(root: Record<string, unknown>): PermissionRule[] | null {
    const section = root["permissions"];
    if (section === undefined) return [];
    return Array.isArray(section) ? (section as PermissionRule[]) : null;
}

/** Parse → switch mode → serialize, preserving every unrelated field.
 * Null when the text isn't plain JSON or `permissions` is malformed. */
export function mergeModeIntoRaw(raw: string, mode: PermissionModeId): string | null {
    const root = parseRoot(raw);
    if (!root) return null;
    const rules = extractPermissionRules(root);
    if (!rules) return null;
    root["permissions"] = applyPermissionMode(rules, mode);
    return JSON.stringify(root, null, 2);
}

/** The JSON body for a fresh document carrying just the mode. */
export function freshModeDocument(mode: PermissionModeId): string {
    return JSON.stringify(
        {$schema: "https://opencode.ai/config.json", permissions: applyPermissionMode([], mode)},
        null,
        2,
    );
}

export type ProjectPermissionState =
    | {kind: "ok"; mode: PermissionModeId; manualCount: number; target: ProjectConfigTarget}
    /** parse = an existing document we cannot parse (JSONC comments or
     * garbage); probe = the read itself failed. */
    | {kind: "blocked"; reason: "parse" | "probe"};

export type PermissionWriteResult =
    | {ok: true}
    | {ok: false; reason: "jsonc" | "parse" | "shape" | "read" | "write"};

/** One candidate read, treating 404 AND 500 as "not there" — the server's
 * fs/read answers 500 for a missing DIRECTORY (the ToolsTab quirk), and a
 * first-run project directory may not exist yet. Anything else rethrows:
 * a genuinely failed read must never read as "absent" (we would clobber). */
async function readCandidate(api: ProjectFsApi, directory: string, name: string): Promise<string | null> {
    try {
        return await api.readTextFile(directory, name);
    } catch (e) {
        const status = (e as {status?: number}).status;
        if (status === 404 || status === 500) return null;
        throw e;
    }
}

/** Find the directory's config document: the first existing candidate,
 * else the `.opencode` file we would create. Throws propagate (probe
 * failures surface as `blocked: "probe"` in the readers below). */
export async function locateProjectConfig(
    api: ProjectFsApi,
    directory: string,
): Promise<ProjectConfigTarget> {
    for (const c of configCandidates(directory)) {
        const name = c.file.slice(directory.replace(/\/+$/, "").length + 1);
        const raw = await readCandidate(api, directory, name);
        if (raw !== null) return {file: c.file, jsonc: c.jsonc, existed: true};
    }
    const dir = directory.replace(/\/+$/, "");
    return {file: `${dir}/.opencode/opencode.json`, jsonc: false, existed: false};
}

/** What the directory's config currently expresses. */
export async function readProjectPermissions(
    api: ProjectFsApi,
    directory: string,
): Promise<ProjectPermissionState> {
    let target: ProjectConfigTarget;
    try {
        target = await locateProjectConfig(api, directory);
    } catch {
        return {kind: "blocked", reason: "probe"};
    }
    if (!target.existed) return {kind: "ok", mode: "strict", manualCount: 0, target};
    const name = target.file.slice(directory.replace(/\/+$/, "").length + 1);
    let raw: string | null;
    try {
        raw = await readCandidate(api, directory, name);
    } catch {
        return {kind: "blocked", reason: "probe"};
    }
    if (raw === null) return {kind: "ok", mode: "strict", manualCount: 0, target};
    const root = parseRoot(raw);
    if (!root) return {kind: "blocked", reason: "parse"};
    const rules = extractPermissionRules(root);
    if (!rules) return {kind: "blocked", reason: "parse"};
    return {kind: "ok", mode: identifyPermissionMode(rules), manualCount: manualRuleCount(rules), target};
}

/** Switch the directory's mode (read → merge → write under the shared
 * config write lock). Never throws — outcomes carry the refusal reason. */
export async function writeProjectPermissionMode(
    api: ProjectFsApi,
    directory: string,
    mode: PermissionModeId,
): Promise<PermissionWriteResult> {
    try {
        return await serializeConfigWrite(async () => {
            let target: ProjectConfigTarget;
            try {
                target = await locateProjectConfig(api, directory);
            } catch {
                return {ok: false as const, reason: "read" as const};
            }
            if (target.jsonc) return {ok: false as const, reason: "jsonc" as const};
            const name = target.file.slice(directory.replace(/\/+$/, "").length + 1);
            const body = await (async () => {
                if (!target.existed) return freshModeDocument(mode);
                let raw: string | null;
                try {
                    raw = await readCandidate(api, directory, name);
                } catch {
                    return null;
                }
                if (raw === null) return freshModeDocument(mode);
                return mergeModeIntoRaw(raw, mode);
            })();
            if (body === null) return {ok: false as const, reason: "shape" as const};
            try {
                await api.writeTextFile(target.file, body);
            } catch {
                return {ok: false as const, reason: "write" as const};
            }
            return {ok: true as const};
        });
    } catch {
        return {ok: false as const, reason: "read" as const};
    }
}
