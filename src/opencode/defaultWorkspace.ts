import {warn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";

/**
 * The DAILY-MODE workspace (~/Documents/LuminaWorkspace): the fixed
 * working directory every "daily" session is created in — the mode's
 * whole point is that a non-developer never has to think about project
 * directories or git, so the app owns one dedicated folder instead.
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
 *  not the user's documents). */
export const SEED_FILE_NAMES = ["README.md", "AGENTS.md"] as const;

export const README_CONTENT = `# LuminaWorkspace

这是 Lumina Code 的日常工作区，用于写作、计划、笔记与资料整理。
日常模式的会话都在这里工作，产出的文档也保存在这个目录。
`;

export const AGENTS_CONTENT = `# 工作模式

这是日常工作的目录（LuminaWorkspace），不是代码仓库。用户在这里处理
写作、计划、笔记、资料整理、日程安排等事务，产出通常是文档而非代码。

- 默认用中文交流与写作，除非用户另有要求。
- 产出以 Word、PPT 等文档为主；文件名简短、含义明确。
- 生成 Word（.docx）或 PPT（.pptx）文档时，必须使用 write_document 工具，
  把内容按结构化块传入 —— 不要写脚本或代码去生成文档，那样不可控
  也不可复现。读取已有文档的内容用 read_document 工具。
- 不执行 git 操作；本目录不是仓库。
- 如果任务确实需要写代码或操作代码仓库，建议用户切换到开发模式
  （在对应项目目录开新会话）。
`;

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
