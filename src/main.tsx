import React from "react";
import ReactDOM from "react-dom/client";
// main.css must load BEFORE the App tree: the typography store reads the
// @theme font stacks at module init, which in dev-mode Vite happens in
// import order (the built app uses a blocking <link> either way).
import "./main.css";
import { attachConsole } from "@tauri-apps/plugin-log";
import {initPersistedState} from "./lib/persistedStore.ts";
import {prewarmKatexFonts} from "./lib/katexFonts.ts";

// KaTeX engine stylesheet + fonts at the ENTRY (see main.css's note for
// why not an @import there; see Markdown.tsx for why not the component).
// Version-locked to rehype-katex's own katex resolution (0.16.x) — a
// DOM (rehype-katex) / CSS (this import) major mismatch silently breaks
// script sizing: 0.16 emits class "sizing", 0.19's rules select
// ".katex-sizing" (live-observed 2026-11).
import "katex/dist/katex.min.css";
// Forward Rust logs to the webview console
attachConsole();

// MATH FONT PREWARM — see lib/katexFonts.ts for why this fires at entry
// module load instead of after boot.
prewarmKatexFonts();

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
