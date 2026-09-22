/**
 * Path display helpers (pure) — shared by the session sidebar's folder
 * headers, the composer's directory picker, and tool-card file paths.
 */

/** Last path segment of a directory path — the compact label for folder
 *  headers and the directory picker. Handles both separators; a path made
 *  of only separators falls back to the trimmed input (never empty). */
export function folderLabel(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, "");
    return trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed || path;
}

/** Display form of a file path: relative to the session's working
 *  directory when the target lives inside the project, the absolute
 *  path untouched when it doesn't. Non-absolute inputs (already-relative
 *  paths, URLs, patterns) pass through unchanged. */
export function displayPath(p: string, directory?: string | null): string {
    if (!directory) return p;
    const absolute = p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
    if (!absolute) return p;
    const sep = directory.includes("\\") ? "\\" : "/";
    const trim = (s: string) => (sep === "/" ? s.replace(/\/+$/, "") : s.replace(/\\+$/, ""));
    // Trim trailing separators on both sides, keeping a bare "/" root intact.
    const base = trim(directory) || (sep === "/" ? "/" : "");
    const target = trim(p);
    if (target === base) return ".";
    const prefix = base.endsWith(sep) ? base : base + sep;
    return target.startsWith(prefix) ? target.slice(prefix.length) : p;
}
