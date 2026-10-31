import React from "react";
import ReactDOM from "react-dom/client";
// main.css must load BEFORE the App tree: the typography store reads the
// @theme font stacks at module init, which in dev-mode Vite happens in
// import order (the built app uses a blocking <link> either way).
import "./main.css";
import { attachConsole, info as logInfo } from "@tauri-apps/plugin-log";
import {initPersistedState} from "./lib/persistedStore.ts";

// KaTeX engine stylesheet + fonts at the ENTRY (see main.css's note for
// why not an @import there; see Markdown.tsx for why not the component).
// Version-locked to rehype-katex's own katex resolution (0.16.x) — a
// DOM (rehype-katex) / CSS (this import) major mismatch silently breaks
// script sizing: 0.16 emits class "sizing", 0.19's rules select
// ".katex-sizing" (live-observed 2026-11).
import "katex/dist/katex.min.css";
// Forward Rust logs to the webview console
attachConsole();

// MATH FONT PREWARM — load every KaTeX webfont family immediately at
// module load (NOT after boot): the transcript restore can render
// formulas within the first second, and WebKit only fetches an
// @font-face lazily once text uses it — a formula laid out with the
// FALLBACK font stacks its vlist levels wrong (fallback metrics are
// taller; live-observed 2026-11: superscripts piling a line low), and
// WebKitGTK does not reliably re-layout already-rendered content when
// the font arrives late. Kicking the requests off NOW (before the App
// bundle even imports) closes the race: the faces are loaded by the
// time the first formula renders.
const KATEX_FAMILIES = [
    "KaTeX_AMS", "KaTeX_Caligraphic", "KaTeX_Fraktur", "KaTeX_Main",
    "KaTeX_Math", "KaTeX_SansSerif", "KaTeX_Script", "KaTeX_Size1",
    "KaTeX_Size2", "KaTeX_Size3", "KaTeX_Size4", "KaTeX_Typewriter",
];
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

// Seed the persisted-state backend BEFORE the app bundle imports: every
// store reads SYNCHRONOUSLY at module evaluation (theme/typography/
// language must apply before the first paint), so the state file must
// already be in memory by then — the same gate pattern as the mobile
// entry (src/mobile/kv.ts). finally(), never then(): a failed seed
// degrades inside initPersistedState (localStorage/memory) and must not
// block the boot. The window stays hidden until App's first paint, so
// the one load round-trip is invisible.
initPersistedState().finally(() => {
    import("./App").then(({default: App}) => {
        ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
            <React.StrictMode>
                <App/>
            </React.StrictMode>,
        );
    });
});
