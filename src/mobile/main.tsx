// The mobile app entry — imported dynamically by kv.ts AFTER the
// localStorage hydrate gate, so every persisted store reads a working
// Storage even on ArkWeb (see kv.ts).
import {StrictMode} from "react";
import {createRoot} from "react-dom/client";

import "../main.css";
import "./mobile.css";
import MobileApp from "./App.tsx";

const root = createRoot(document.getElementById("root")!);
root.render(
    <StrictMode>
        <MobileApp />
    </StrictMode>,
);
// The splash node in mobile/index.html has served its purpose.
document.getElementById("splash")?.remove();
