import {FILE_ICON_DEFAULT, FILE_ICON_EXTENSIONS, FILE_ICON_NAMES} from "./fileIcons.generated.ts";

/**
 * File-type icon lookup over the Material Icon Theme set (the VS Code
 * extension's icons, MIT — see THIRD_PARTY_NOTICES.md). The SVGs live as
 * static assets under public/icons/files and the filename/extension maps
 * in fileIcons.generated.ts; both are produced by `pnpm gen:icons`
 * (scripts/gen-file-icons.mjs) and committed.
 *
 * Resolution mirrors VS Code's icon-theme order: exact filename first
 * (package.json, .gitignore, …), then the extension (rs, ts, …), then the
 * generic file icon. Pure — colocated test in fileIcons.test.ts.
 */

/** Where the generated SVGs are served from (Vite's public/ → /icons/…). */
const ICON_BASE = "/icons/files";

function baseName(path: string): string {
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return path.slice(slash + 1).toLowerCase();
}

/** Material icon name for a file path (filename → extension → default). */
export function fileIconName(path: string): string {
    const base = baseName(path);
    const byName = FILE_ICON_NAMES[base];
    if (byName) return byName;
    // dot > 0: a leading dot makes a file a dotfile, not ".ext"-shaped —
    // those resolve through the exact-filename map above or fall through.
    const dot = base.lastIndexOf(".");
    if (dot > 0) {
        const byExt = FILE_ICON_EXTENSIONS[base.slice(dot + 1)];
        if (byExt) return byExt;
    }
    return FILE_ICON_DEFAULT;
}

/** URL of the icon for a file path (a static asset under public/icons). */
export function fileIconUrl(path: string): string {
    return `${ICON_BASE}/${fileIconName(path)}.svg`;
}
