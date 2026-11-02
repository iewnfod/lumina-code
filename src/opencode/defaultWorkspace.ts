import {warn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";

/**
 * The DAILY-MODE workspace (~/Documents/LuminaWorkspace): the fixed
 * working directory every "daily" session lives under — the mode's
 * whole point is that a non-developer never has to think about project
 * directories or git, so the app owns one dedicated folder instead.
 *
 * PER-SESSION SUBDIRECTORIES: every new daily session gets its OWN
 * folder at <workspace>/Sessions/<name>/ (created on the first send,
 * named readably from the first prompt — see resolveSessionDirectory).
 * The session's working directory IS that folder, so each session's
 * documents stay isolated (the workspace panel scans the session's own
 * directory only) and nothing piles up at the workspace root. The
 * root's AGENTS.md still governs every session: OpenCode loads
 * AGENTS.md from the session directory UPWARD toward home
 * (opencode.ai/v2/docs/instructions), and the workspace sits under
 * $HOME — verified, the daily mode's behavioral half survives the
 * nesting. Session directories are create-only (like session
 * metadata), so the name is minted once from the first prompt and
 * never renamed even after the server generates a session title.
 *
 * The path derives from the server's own working directory
 * (GET /api/location): Lumina Code spawns `opencode serve` with cwd =
 * $HOME (src-tauri/src/opencode/mod.rs), which is what makes that read
 * the user's home. Every write goes through the same fs channel the
 * lumina-tools installer uses (fs/write creates parent directories —
 * curl-verified v2.0.11), so first use materializes the folder.
 *
 * On first creation the workspace is seeded with a README (what this
 * folder is) and an AGENTS.md (the "work mode" guidance the server
 * reads for every session in this directory — that file IS the daily
 * mode's behavioral half; no app-level mode system needed). Both files
 * are written ONLY when fs/read answers 404: an existing file is never
 * overwritten, and a FAILED read is never treated as "absent" (the
 * readOrNull contract, see api.ts) — we skip instead of clobbering
 * something we could not see.
 */

/** The workspace folder's name under ~/Documents. */
export const DEFAULT_WORKSPACE_NAME = "LuminaWorkspace";

/** The seed files {@link ensureDefaultWorkspace} plants at the workspace
 *  ROOT. Exported as the ONE name list because the daily panel consumes
 *  it too (workspaceDocuments.ts hides these from the document
 *  inventory — they are workspace infrastructure the app itself wrote,
 *  not the user's documents).
 *
 *  UPGRADE NOTE: seeds write ONLY on a missing file (the readOrNull
 *  contract below) — an AGENTS.md planted by an older build stays as
 *  the user's copy forever. The content here serves NEW workspaces;
 *  existing users edit theirs by hand. */
export const SEED_FILE_NAMES = ["README.md", "AGENTS.md"] as const;

export const README_CONTENT = `# LuminaWorkspace

这是 Lumina Code 的日常工作区，用于写作、计划、笔记与资料整理。
日常模式的每个会话都在 Sessions/ 下拥有自己的专属文件夹，会话中
产出的文档保存在那个文件夹里，互不混放；你放在工作区根目录的
文件由更早的会话（或你自己）管理。
`;

export const AGENTS_CONTENT = `# 工作模式

这是日常工作的区域（LuminaWorkspace），不是代码仓库。你所在的目录是
本次会话的专属文件夹（Sessions/ 下的一个子目录），用户在这里处理
写作、计划、笔记、资料整理、日程安排等事务，产出通常是文档而非代码。

回答风格：
- 默认用中文交流与写作，除非用户另有要求。
- 直接、简洁，先给结论；大多数问题不需要调用任何工具，好的回答
  本身就是交付。
- 需要查证时优先读当前文件夹的资料；读取较长文件时分段读取，
  不要一次性读完整文件。
- 拿不准需求时先问清楚，不要凭猜测开工。

文档产出：
- 产出以 Word、PPT 等文档为主；文件名简短、含义明确。
- 产出的文档一律保存在当前目录（本次会话的文件夹）内，不要写到
  上级目录或其他会话的文件夹。
- 生成 Word（.docx）或 PPT（.pptx）文档时，必须使用 write_document 工具，
  把内容按结构化块传入 —— 不要写脚本或代码去生成文档，那样不可控
  也不可复现。读取已有文档的内容用 read_document 工具。

其他：
- 不执行 git 操作；本目录不是仓库。
- 如果任务确实需要写代码或操作代码仓库，建议用户切换到开发模式
  （在对应项目目录开新会话）。
`;

/** The container folder under the workspace holding one directory per
 * daily session. A FIXED name (not localized — disk structure stays
 * locale-neutral) is also what the document scan's exclusion predicate
 * keys on: a legacy root-level session must not see the newer
 * sessions' files (workspaceDocuments.ts). */
export const SESSIONS_DIR_NAME = "Sessions";

/** The hidden marker file materializing + claiming one session folder
 * (`.lumina-session.json`, written by {@link resolveSessionDirectory}):
 * fs/write creating it is what creates the directory itself — the
 * server's bash tool needs the cwd to EXIST before the first prompt —
 * and its presence is the name-taken probe for dedupe (-2, -3…).
 * Hidden on purpose: the POSIX scan's hidden-path exclusion (`-not
 * -path` with a leading-dot pattern) never lists it (the PowerShell
 * fallback does and is filtered by basename). */
export const SESSION_MARKER_NAME = ".lumina-session.json";

/** Cap on a session folder name derived from the first prompt: enough
 * to stay readable in a file manager, short enough to never blow up
 * paths. */
const SESSION_FOLDER_MAX = 24;

/** Readable folder name from the session's first prompt (the user's
 * chosen naming scheme): first line, NFKC, quotes dropped, anything
 * that isn't a letter/digit folded to dashes (the planFileSlug
 * algorithm's frontend sibling — the plugin source is a plain-JS
 * no-imports island, so the handful of lines are mirrored here rather
 * than imported), capped, edge dashes trimmed. CJK prompts stay
 * verbatim (帮我写周报 → 帮我写周报). An EMPTY result falls back to
 * `fallbackStamp` (会话-YYYY-MM-DD-HHmm, minted by the caller so tests
 * can pin the clock). */
export function sessionFolderName(prompt: string, fallbackStamp: string): string {
    const firstLine = String(prompt ?? "").split("\n", 1)[0] ?? "";
    const name = firstLine
        .normalize("NFKC")
        // Quotes DROP (not fold to dashes): “总结” → 总结 reads better
        // in a folder name than 总结-with-a-dash-either-side would.
        .replace(/['’‘“”「」『』]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, SESSION_FOLDER_MAX)
        .replace(/-+$/g, "");
    return name || fallbackStamp;
}

/** The timestamp fallback's stamp: 会话-YYYY-MM-DD-HHmm (history/
 * snapshot naming's pad pattern). */
function sessionStamp(now: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `会话-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Marker body — provenance for anyone inspecting the folder (the file
 * manager crowd included); also what a later dedupe probe reads back
 * as "taken". */
function sessionMarkerContent(): string {
    return JSON.stringify({app: "lumina-code", kind: "session-folder", createdAt: new Date().toISOString()});
}

/** Read a candidate folder's marker, tolerating the fs/read
 * missing-DIRECTORY quirk: v2.0.11 answers 500 (not 404) when the
 * directory doesn't exist yet — for the name probe that is exactly
 * "free" (the ensureSeedFile precedent). Returns null = free name,
 * a string = taken; anything else rethrows (the caller refuses to
 * guess over an unreadable state). */
async function probeSessionMarker(api: OpencodeApi, directory: string): Promise<string | null> {
    try {
        return await api.readTextFile(directory, SESSION_MARKER_NAME);
    } catch (e) {
        if ((e as {status?: number}).status === 500) return null;
        throw e;
    }
}

/** Resolve (and MATERALIZE) the per-session directory a daily first
 * send should use: <workspace>/Sessions/<name>/ with the name minted
 * from the first prompt, deduped -2, -3… while the marker probe
 * reports the name taken (the plugin's planDirName pattern — no fs
 * locks, so two windows racing an identical prompt may share a folder;
 * accepted, same known edge). Returns null on any unrecoverable
 * failure (unreadable probe state, marker write failure — the caller
 * falls back to the workspace ROOT rather than hand the session a
 * directory the server's bash could not cd into). Never throws. */
export async function resolveSessionDirectory(
    api: OpencodeApi,
    workspace: string,
    prompt: string,
): Promise<string | null> {
    const base = sessionFolderName(prompt, sessionStamp(new Date()));
    const root = workspace.replace(/\/+$/, "");
    for (let n = 1; n <= 20; n++) {
        const name = n === 1 ? base : `${base}-${n}`;
        const directory = `${root}/${SESSIONS_DIR_NAME}/${name}`;
        let marker: string | null;
        try {
            marker = await probeSessionMarker(api, directory);
        } catch (e) {
            // An unreadable state is not "free" — occupying on a guess
            // could nestle a session beside files we failed to see.
            await warn(`Session-folder probe failed for ${directory}: ${e}`).catch(() => {});
            return null;
        }
        if (marker !== null) continue; // taken — try the next sibling
        try {
            // The write itself creates Sessions/<name>/ (fs/write
            // creates parents) — the materialization step.
            await api.writeTextFile(`${directory}/${SESSION_MARKER_NAME}`, sessionMarkerContent());
            return directory;
        } catch (e) {
            await warn(`Session-folder materialization failed for ${directory}: ${e}`).catch(() => {});
            return null;
        }
    }
    await warn(`Session-folder name exhausted 20 collisions for "${base}"`).catch(() => {});
    return null;
}

/** The workspace path under a home directory (trailing slashes on the
 *  home tolerated — the `${dir}/…` join convention, see
 *  toolPluginConfig.ts; forward slashes also work for the server on
 *  Windows). */
export function defaultWorkspacePath(home: string): string {
    return `${home.replace(/\/+$/, "")}/Documents/${DEFAULT_WORKSPACE_NAME}`;
}

/** Resolve the workspace path from the LIVE server (its working
 *  directory = the user's home). Null when the location read fails —
 *  callers degrade to no directory (the server's own default), never
 *  to a guessed path. */
export async function resolveDefaultWorkspace(api: OpencodeApi): Promise<string | null> {
    try {
        const location = await api.getLocation();
        const home = location?.directory;
        return home ? defaultWorkspacePath(home) : null;
    } catch (e) {
        await warn(`Failed to resolve the default workspace home: ${e}`).catch(() => {});
        return null;
    }
}

/** Materialize the workspace folder and seed its two files. Best
 *  effort — a failed ensure logs and returns so a first send is never
 *  blocked (the session still lands in the directory; only the
 *  seeding text is missing). */
export async function ensureDefaultWorkspace(api: OpencodeApi, path: string): Promise<void> {
    const seeds: Record<string, string> = {
        "README.md": README_CONTENT,
        "AGENTS.md": AGENTS_CONTENT,
    };
    for (const name of SEED_FILE_NAMES) {
        await ensureSeedFile(api, path, name, seeds[name]);
    }
}

async function ensureSeedFile(
    api: OpencodeApi,
    directory: string,
    name: string,
    content: string,
): Promise<void> {
    let existing: string | null;
    try {
        existing = await api.readTextFile(directory, name);
    } catch (e) {
        // 404 (absent file) already reads as null inside readTextFile.
        // 500 is the documented fs/read MISSING-DIRECTORY quirk (see
        // sessionWhitelistSync) — the very state the seed write exists
        // to fix (fs/write creates parents), so it proceeds like an
        // absent file. Any OTHER failure is not "absent" — rewriting on
        // that assumption could clobber a file we failed to see.
        if ((e as {status?: number}).status !== 500) {
            await warn(`Workspace seed read failed for ${name}: ${e}`).catch(() => {});
            return;
        }
        existing = null;
    }
    if (existing !== null) return; // already there (user-edited or a
    // previous ensure) — never overwritten.
    try {
        // fs/write creates the parent directories — the first write is
        // what actually creates the workspace folder.
        await api.writeTextFile(`${directory}/${name}`, content);
    } catch (e) {
        await warn(`Workspace seed write failed for ${name}: ${e}`).catch(() => {});
    }
}
