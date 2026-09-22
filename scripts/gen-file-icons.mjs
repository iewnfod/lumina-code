#!/usr/bin/env node
// Generates the file-type icon assets used by src/lib/fileIcons.ts:
//   public/icons/files/*.svg          — referenced Material Icon Theme SVGs
//   src/lib/fileIcons.generated.ts    — filename/extension → icon-name maps
//
// Source: the material-icon-theme npm package (MIT) — the same icon set as
// the VS Code extension, packaged for use in any web project. Its
// generateManifest() returns the VS Code icon-theme manifest (icon
// definitions + fileNames/fileExtensions associations), which this script
// flattens into two lookup maps; only icons referenced by those maps are
// copied (~590 of the package's 1251 SVGs — folder icons and language-id
// associations stay out).
//
// Run after bumping material-icon-theme in package.json:
//   pnpm gen:icons
//
// The output is COMMITTED on purpose: neither `pnpm build` nor fresh clones
// then depend on a codegen step. Light-theme variants (manifest.light, a
// few dozen overrides) are skipped — the default mid-tone icons read on
// both light and dark surfaces.
import {copyFile, mkdir, rm, stat, writeFile} from "node:fs/promises";
import {existsSync, readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {basename, dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {generateManifest} from "material-icon-theme";

const require = createRequire(import.meta.url);
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_ICONS_DIR = join(REPO_ROOT, "public", "icons", "files");
const OUT_TS = join(REPO_ROOT, "src", "lib", "fileIcons.generated.ts");

/** Locate a package's root directory by walking up from its entry point
 *  (the package restricts its `exports`, so package.json isn't resolvable
 *  as a subpath). */
function packageRoot(name) {
    let dir = dirname(require.resolve(name));
    while (true) {
        const pkgJson = join(dir, "package.json");
        if (existsSync(pkgJson) && JSON.parse(readFileSync(pkgJson, "utf8")).name === name) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) throw new Error(`cannot locate the package root of ${name}`);
        dir = parent;
    }
}

const manifest = generateManifest({});

// Associations, lowercased so lookups can lowercase too (VS Code lowercases
// before consulting an icon theme).
function lowercaseMap(associations) {
    const out = {};
    for (const [key, value] of Object.entries(associations)) out[key.toLowerCase()] = value;
    return out;
}
const fileNames = lowercaseMap(manifest.fileNames ?? {});
const fileExtensions = lowercaseMap(manifest.fileExtensions ?? {});
const fallback = manifest.file;

// The copy set: every icon the two maps plus the default reference.
const referenced = new Set([...Object.values(fileNames), ...Object.values(fileExtensions)]);
if (!fallback || !manifest.iconDefinitions[fallback]) {
    throw new Error("manifest has no default file icon definition");
}
referenced.add(fallback);

await rm(OUT_ICONS_DIR, {recursive: true, force: true});
await mkdir(OUT_ICONS_DIR, {recursive: true});

const iconsDir = join(packageRoot("material-icon-theme"), "icons");
let bytes = 0;
for (const icon of [...referenced].sort()) {
    const definition = manifest.iconDefinitions[icon];
    if (!definition) throw new Error(`manifest has no icon definition for "${icon}"`);
    // The destination keeps the definition NAME (that's what the lookup
    // maps emit); iconPath's basename is the source of truth in the package.
    const source = join(iconsDir, basename(definition.iconPath));
    if (!existsSync(source)) throw new Error(`icon SVG missing in package: ${source}`);
    await copyFile(source, join(OUT_ICONS_DIR, `${icon}.svg`));
    bytes += (await stat(source)).size;
}

function record(map) {
    const entries = Object.keys(map)
        .sort()
        .map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(map[key])}`);
    return `{\n${entries.join(",\n")},\n}`;
}

await writeFile(
    OUT_TS,
    `// GENERATED FILE — do not edit; regenerate with \`pnpm gen:icons\`
// (scripts/gen-file-icons.mjs). Source: the material-icon-theme npm
// package (MIT) — see THIRD_PARTY_NOTICES.md. Keys are lowercase; the
// lookup order in lib/fileIcons.ts is exact filename → extension → default.

/** Exact-match filenames (lowercased, including dotfiles) → icon name. */
export const FILE_ICON_NAMES: Record<string, string> = ${record(fileNames)};

/** File extensions (lowercased, without the dot) → icon name. */
export const FILE_ICON_EXTENSIONS: Record<string, string> = ${record(fileExtensions)};

/** Icon for files matching neither map (manifest.file). */
export const FILE_ICON_DEFAULT = ${JSON.stringify(fallback)};
`,
);

console.log(`→ ${referenced.size} icons (${(bytes / 1e6).toFixed(1)} MB) → ${OUT_ICONS_DIR}`);
console.log(
    `→ ${Object.keys(fileNames).length} filenames + ${Object.keys(fileExtensions).length} extensions → ${OUT_TS}`,
);
