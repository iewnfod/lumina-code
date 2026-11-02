#!/usr/bin/env node
// Regenerates the HarmonyOS app icon set under mobile/src-tauri/gen/ohos from
// the committed 1024 master (mobile/src-tauri/icons/icon.png — the same
// designer export the desktop/Android sets derive from). `tauri icon` does
// NOT cover the ohos DevEco project, so without this script gen/ohos ships
// the DevEco NEW-PROJECT TEMPLATE icons forever (the blue grid "startIcon" +
// blue/white layered pair — live-observed on device 2026-11-02). Doctrine
// follows gen:icons / gen:app-icon: the script is rerunnable, the OUTPUTS
// are committed (CI never runs this).
//
// DELIBERATELY the plain desktop icon, no mobile-specific treatment yet
// (user's call 2026-11-02: a dedicated mobile icon comes later): the
// foreground is the master AS-IS — the system's super-ellipse mask simply
// shaves the squircle's glow corners. When the dedicated icon lands, this is
// the place to add content scaling / layered artwork.
//
// Outputs (all overwritten in place, JSON manifests untouched — they already
// reference $media:foreground / $media:background / $media:startIcon):
//   gen/ohos/AppScope/resources/base/media/{foreground,background}.png
//   gen/ohos/entry/src/main/resources/base/media/{foreground,background,startIcon}.png
//
// Requires ImageMagick (`magick`) on PATH.
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = join(ROOT, "mobile/src-tauri/icons/icon.png");
const OHOS_MEDIA = [
    join(ROOT, "mobile/src-tauri/gen/ohos/AppScope/resources/base/media"),
    join(ROOT, "mobile/src-tauri/gen/ohos/entry/src/main/resources/base/media"),
];

/** Launch/splash icon size (DevEco template ships 144x144). */
const START_ICON_SIZE = 144;

function magick(args, captureStdout = false) {
    return execFileSync("magick", args, {stdio: ["ignore", captureStdout ? "pipe" : "inherit", "inherit"]});
}

const tmp = await mkdtemp(join(tmpdir(), "lumina-ohos-icons-"));
try {
    // Sanity: the master must exist (committed — a missing one means someone
    // let the CLI re-encode it away, see AGENTS.md's icon doctrine).
    const hasMaster = (await readdir(dirname(MASTER))).includes("icon.png");
    if (!hasMaster) throw new Error(`master icon missing: ${MASTER}`);

    // foreground: the master as-is (transparent-background squircle, 1024).
    const foreground = join(tmp, "foreground.png");
    magick([MASTER, `PNG32:${foreground}`]);

    // background: the master's average color as a flat plate — the only
    // layer that must be synthesized (layered_image.json references it; the
    // system mask exposes it as a thin ring that must blend with the
    // squircle's own light-silver base).
    const avg = magick([
        MASTER, "-resize", "1x1!", "-format", "%[fx:int(255*r)],%[fx:int(255*g)],%[fx:int(255*b)]", "info:",
    ], true).toString().trim();
    const background = join(tmp, "background.png");
    magick(["-size", "1024x1024", `xc:rgb(${avg})`, `PNG32:${background}`]);

    // launch icon: plain downscale of the master.
    const startIcon = join(tmp, "startIcon.png");
    magick([MASTER, "-resize", `${START_ICON_SIZE}x${START_ICON_SIZE}`, `PNG32:${startIcon}`]);

    // AppScope: the app-level layered pair only. Entry: the pair + the
    // launch/splash icon (AppScope has no startIcon reference).
    const [appScope, entry] = OHOS_MEDIA;
    await copyFile(foreground, join(appScope, "foreground.png"));
    await copyFile(background, join(appScope, "background.png"));
    await copyFile(foreground, join(entry, "foreground.png"));
    await copyFile(background, join(entry, "background.png"));
    await copyFile(startIcon, join(entry, "startIcon.png"));
    console.log(`ohos icons regenerated from the desktop master (base plate rgb(${avg})):`);
    console.log(`  ${OHOS_MEDIA.map((d) => d.replace(ROOT + "/", "")).join("\n  ")}`);
} finally {
    await rm(tmp, {recursive: true, force: true});
}
