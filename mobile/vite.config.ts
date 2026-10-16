import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {defineConfig} from "vite";

const here = (p: string) => new URL(p, import.meta.url).pathname;

/**
 * The MOBILE build — the second vite entry (the desktop app builds from
 * the root index.html into dist/; this config builds mobile/index.html
 * into dist-mobile/ for mobile/src-tauri's frontendDist).
 *
 * The project root is THIS directory so the entry lands flat at
 * dist-mobile/index.html; the PUBLIC dir still points at the repo
 * root's (shared file-type icons + fonts). The mobile app reuses the
 * desktop's rendering components wholesale — its bundle resolves
 * `../src/…` imports without any aliasing.
 *
 * Dev server on 1421 (the desktop uses 1420) so both can run at once.
 */
export default defineConfig({
    root: here("."),
    publicDir: here("../public"),
    cacheDir: here("../node_modules/.vite-mobile"),
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    server: {
        // `cargo tauri ohos dev` exports TAURI_DEV_HOST (the LAN IP the
        // DEVICE loads the dev server from) — bind it so the phone can
        // reach vite. Standalone `pnpm dev:mobile` stays on localhost.
        host: process.env.TAURI_DEV_HOST ?? "localhost",
        port: 1421,
        strictPort: true,
    },
    build: {
        outDir: here("../dist-mobile"),
        emptyOutDir: true,
    },
});
