// The mobile app entry — imported dynamically by kv.ts AFTER the
// localStorage hydrate gate, so every persisted store reads a working
// Storage even on ArkWeb (see kv.ts). The design system (main.css +
// mobile.css) is imported HERE — the JS module graph — because
// @tailwindcss/vite only expands the tailwind import for module CSS
// (a static html link ships handwritten rules without the utilities;
// see the note in mobile/index.html).
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
