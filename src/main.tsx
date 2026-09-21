import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./main.css";
import { attachConsole } from "@tauri-apps/plugin-log";

// Forward Rust logs to the webview console
attachConsole();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <App/>
    </React.StrictMode>,
);
