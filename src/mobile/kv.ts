// The MOBILE entry plants its flag BEFORE the app bundle imports —
// lib/platform.ts's isMobileApp() keys connection mode + chrome gating
// off it (see useOpencode's remote branch).
window.__LUMINA_MOBILE__ = true;

// The persistence gate — mobile.html loads THIS module first; the app
// bundle is only imported (dynamically) after the state file is seeded,
// so every module-level store read in the app happens against a seeded
// backend, synchronously, exactly like the desktop entry (src/main.tsx).
//
// This used to be the ArkWeb localStorage hydrate shim (kv_load/kv_set
// in the Rust shell): HarmonyOS's ArkWeb returns null for localStorage
// under the tauri:// scheme. tauri-plugin-store replaced it — the
// plugin rides the invoke channel, which works wherever invoke works,
// so the shim's whole reason (and the commands behind it) is gone.
import {initPersistedState} from "../lib/persistedStore.ts";

await initPersistedState();

// Only now import the app — its module graph reads persisted state at
// evaluation time (persistedStore factory).
await import("./main.tsx");
