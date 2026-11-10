// KaTeX webfont prewarm — shared by BOTH vite entries (desktop
// src/main.tsx, mobile src/mobile/main.tsx). DOM-bound but React-free
// (the lib/clipboard.ts precedent); logging follows the lib/persistedStore.ts
// pattern (plugin-log import + .catch guard, so a plugin-less shell like
// ohos just swallows the invoke rejection).
import {info as logInfo} from "@tauri-apps/plugin-log";

// Every KaTeX webfont family the engine stylesheet declares (see the
// katex.min.css @font-face blocks). Keep in sync with the installed
// katex 0.16.x — a family name change makes its entry log "none".
const KATEX_FAMILIES = [
    "KaTeX_AMS", "KaTeX_Caligraphic", "KaTeX_Fraktur", "KaTeX_Main",
    "KaTeX_Math", "KaTeX_SansSerif", "KaTeX_Script", "KaTeX_Size1",
    "KaTeX_Size2", "KaTeX_Size3", "KaTeX_Size4", "KaTeX_Typewriter",
];

/**
 * Load every KaTeX webfont family immediately (NOT after boot): the
 * transcript restore can render formulas within the first second, and
 * a web engine only fetches an @font-face lazily once text uses it — a
 * formula laid out with the FALLBACK font stacks its vlist levels wrong
 * (fallback metrics are taller; live-observed 2026-11: superscripts
 * piling a line low), and WebKitGTK does not reliably re-layout
 * already-rendered content when the font arrives late. Kicking the
 * requests off at ENTRY module load (before the App bundle even
 * imports) closes the race: the faces are loaded by the time the first
 * formula renders.
 */
export function prewarmKatexFonts(): void {
    const prewarmStarted = Date.now();
    Promise.all(
        KATEX_FAMILIES.map((family) =>
            document.fonts.load(`1em ${family}`)
                .then((loaded) => `${family}:${loaded.length ? "ok" : "none"}`)
                .catch((e: unknown) => `${family}:ERR ${String(e).slice(0, 60)}`),
        ),
    ).then((results) => {
        logInfo(`[math-prewarm] ${Date.now() - prewarmStarted}ms ${results.join(",")}`).catch(() => {});
    });
}
