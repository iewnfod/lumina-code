import React from "react";
import ReactDOM from "react-dom/client";
// main.css must load BEFORE the App tree: the typography store reads the
// @theme font stacks at module init, which in dev-mode Vite happens in
// import order (the built app uses a blocking <link> either way).
import "./main.css";
import { attachConsole } from "@tauri-apps/plugin-log";
import {initPersistedState} from "./lib/persistedStore.ts";

// Forward Rust logs to the webview console
attachConsole();

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
