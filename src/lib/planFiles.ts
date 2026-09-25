/**
 * Plan-workflow document persistence (pure): the filename slug and the
 * document body for the plan file Lumina Code writes on approval
 * (`.lumina/plans/<date>-<slug>.md` under the session's directory, via
 * the server's experimental fs/write — see api.ts). Pure so the naming
 * is node-testable; the write itself lives in the approval card's
 * handler (it owns the api handle and the session directory).
 */

/** Filename-safe slug for a plan title. Unicode-aware (CJK titles stay
 * readable), lowercased, runs of anything else collapsed to dashes,
 * capped so long titles don't blow up paths. */
export function planFileSlug(title: string): string {
    const slug = title
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[''']/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
        .replace(/-+$/g, "");
    return slug || "plan";
}

/** The plan file's name: `YYYY-MM-DD-<slug>.md`, `-2`, `-3`, … when the
 * callback reports a collision (same-day revisions of one title). The
 * exists-probe may be async (the fs/read round-trip); a probe that
 * errors counts as "absent" — worst case a same-name revision
 * overwrites, never a blocked approval. */
export async function planFileName(
    title: string,
    now: Date,
    exists: (name: string) => boolean | Promise<boolean>,
): Promise<string> {
    const pad = (n: number) => String(n).padStart(2, "0");
    const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${planFileSlug(title)}`;
    let name = `${base}.md`;
    for (let n = 2; await exists(name); n++) name = `${base}-${n}.md`;
    return name;
}

/** Assemble the self-contained plan document: the submitted markdown
 * plus a checklist appendix carrying the task statuses, so the file
 * alone reconstructs the plan's shape. */
export function composePlanDocument(
    title: string,
    plan: string,
    todos: readonly {title: string; status: string; reason?: string}[],
): string {
    const checklist = todos
        .map((t, i) => {
            const box = t.status === "completed" ? "x" : t.status === "blocked" ? "!" : " ";
            const note = t.status === "blocked" && t.reason ? ` — blocked: ${t.reason}` : "";
            return `${i + 1}. [${box}] ${t.title}${note}`;
        })
        .join("\n");
    return `# ${title}\n\n${plan.trim()}\n\n---\n\n## Tasks\n\n${checklist}\n`;
}
