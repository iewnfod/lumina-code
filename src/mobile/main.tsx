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
// KaTeX engine stylesheet + font prewarm — the SAME entry-level doctrine
// as the desktop (src/main.tsx; see main.css's note for why not an
// @import there): the mobile bundle ships the KaTeX DOM (the real
// desktop tree renders the transcript) but its stylesheet lives ONLY in
// an entry js import — without this line the fonts never load and every
// formula renders in fallback metrics (live-observed 2026-11, mobile).
import "katex/dist/katex.min.css";
import {prewarmKatexFonts} from "../lib/katexFonts.ts";
import MobileApp from "./App.tsx";

prewarmKatexFonts();

const root = createRoot(document.getElementById("root")!);
root.render(
    <StrictMode>
        <MobileApp />
    </StrictMode>,
);
// The splash node in mobile/index.html has served its purpose.
document.getElementById("splash")?.remove();
