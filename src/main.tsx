import React from "react";
import ReactDOM from "react-dom/client";
// main.css must load BEFORE the App tree: the typography store reads the
// @theme font stacks at module init, which in dev-mode Vite happens in
// import order (the built app uses a blocking <link> either way).
import "./main.css";
import App from "./App";
import { attachConsole } from "@tauri-apps/plugin-log";

// Forward Rust logs to the webview console
attachConsole();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <App/>
    </React.StrictMode>,
);
