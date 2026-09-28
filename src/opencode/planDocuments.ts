import type {OpencodeApi} from "./api.ts";
import {readStoredZipEntry} from "../lib/zipReader.ts";

/**
 * Read-only access to the plan workflow's on-disk mirror (written by the
 * plugin — see src/plugins/luminaTools.js, the ONLY writer). The frontend
 * resolves the session's task directory and reads plan.md / report.md for
 * the stats panel's view buttons; it never writes or deletes.
 *
 * planFileSlugTs is the TypeScript twin of the plugin's planFileSlug and
 * MUST stay in sync — same dual-mirror discipline as collectSessionTodos
 * ↔ planStateFromEntries (the plugin file isn't importable from TS:
 * tsconfig has no allowJs).
 */

/** Filename-safe slug for a plan title — the plugin's planFileSlug,
 * mirrored. Unicode-aware (CJK stays readable), lowercased, runs of
 * anything else collapsed to dashes, capped at 60. */
export function planFileSlugTs(title: string): string {
    const slug = title
        .normalize("NFKC")
        .toLowerCase()
        .replace(/['’‘]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
        .replace(/-+$/g, "");
    return slug || "plan";
}

/** fs/read that treats every failure as "absent" (a missing file is the
 * common case while probing — see api.ts for the v2.0.11 quirks). */
async function readOrNull(api: OpencodeApi, directory: string, file: string): Promise<string | null> {
    try {
        return await api.readTextFile(directory, file);
    } catch {
        return null;
    }
}

/**
 * The session's task directory name under `<directory>/.lumina/tasks/`,
 * resolved with the SAME anchoring contract the plugin writes: probe the
 * slug (then -2, -3… bounded — collisions from other sessions' same-title
 * plans) and match plan.md's header anchor. Null when nothing matches:
 * the plan was archived (directory removed), wiped, or predates the
 * mirror.
 */
export async function findSessionTaskDir(
    api: OpencodeApi,
    directory: string,
    sessionId: string,
    title: string,
): Promise<string | null> {
    const base = planFileSlugTs(title);
    const anchor = `<!-- lumina: session=${sessionId} -->`;
    for (let n = 1; n <= 6; n++) {
        const name = n === 1 ? base : `${base}-${n}`;
        const plan = await readOrNull(api, directory, `.lumina/tasks/${name}/plan.md`);
        if (plan !== null && plan.startsWith(anchor)) return name;
    }
    return null;
}

/** Read one document out of the session's (already resolved) task
 * directory. Null when the file is absent. */
export function readTaskDocument(
    api: OpencodeApi,
    directory: string,
    dirName: string,
    file: "plan.md" | "report.md",
): Promise<string | null> {
    return readOrNull(api, directory, `.lumina/tasks/${dirName}/${file}`);
}

/**
 * The session's ACCEPTED archive: after acceptance the task directory is
 * gone and the documents live inside `.lumina/archived/{slug}.zip` (plus
 * collision suffixes, mirroring the task-dir naming). Probes the same
 * bounded sequence, claims the zip whose plan.md entry carries this
 * session's anchor, and returns a lazy per-file reader over its bytes.
 * Null when no archive matches.
 */
export async function findSessionArchive(
    api: OpencodeApi,
    directory: string,
    sessionId: string,
    title: string,
): Promise<{read: (file: "plan.md" | "report.md") => string | null} | null> {
    const base = planFileSlugTs(title);
    const anchor = `<!-- lumina: session=${sessionId} -->`;
    for (let n = 1; n <= 6; n++) {
        const name = n === 1 ? `${base}.zip` : `${base}-${n}.zip`;
        let bytes: Uint8Array | null = null;
        try {
            const blob = await api.readFileBlob(directory, `.lumina/archived/${name}`);
            if (blob) bytes = new Uint8Array(await blob.arrayBuffer());
        } catch {
            bytes = null; // absent — next candidate
        }
        if (!bytes) continue;
        const plan = readStoredZipEntry(bytes, "plan.md");
        if (plan !== null && plan.startsWith(anchor)) {
            return {read: (file) => readStoredZipEntry(bytes!, file)};
        }
    }
    return null;
}

/** Strip the ownership anchor the plugin stamps as the first line — it's
 * protocol, not content, and must not ride along into a reading surface. */
export function stripPlanAnchor(content: string): string {
    return content.replace(/^<!-- lumina: session=[^>]*-->\n+/, "");
}
