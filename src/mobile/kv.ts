import {invoke} from "@tauri-apps/api/core";

/**
 * The localStorage hydrate gate — mobile.html loads THIS module first;
 * the app bundle is only imported (dynamically) after hydration, so
 * every module-level store read in the app happens against a working
 * Storage, synchronously, exactly like the desktop.
 *
 * Why this exists: HarmonyOS's ArkWeb returns null for localStorage
 * under the tauri:// custom scheme (live-observed by the ohos porting
 * guides). Without the shim every persistedStore degrades to
 * in-memory (persistedStore never throws — safeGet/set catch), which
 * works but forgets the login token on every launch.
 *
 * The shim hydrates from the Rust-side KV file (kv_load → JSON map),
 * then write-behinds each mutation (kv_set, fire-and-forget; null
 * value = remove). Where localStorage DOES work (desktop browser dev,
 * other platforms) the native one is used untouched.
 */

async function installStorage(): Promise<void> {
    const works = (() => {
        try {
            window.localStorage.setItem("__lumina_probe__", "1");
            window.localStorage.removeItem("__lumina_probe__");
            return true;
        } catch {
            return false;
        }
    })();
    if (works) return;

    // Hydrate from Rust (best effort — an IPC failure means a session-
    // only store, still fully functional).
    const memory = new Map<string, string>();
    try {
        // A 3s timeout guards against a hung invoke blocking the app
        // import forever (blank screen); hydration is best-effort.
        const raw = await Promise.race([
            invoke<string>("kv_load"),
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error("kv_load timeout")), 3000),
            ),
        ]);
        const parsed = JSON.parse(raw) as Record<string, string>;
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "string") memory.set(key, value);
        }
    } catch (e) {
        console.warn(`[kv] hydration skipped: ${e}`);
    }

    const writeBehind = (key: string, value: string | null) => {
        invoke("kv_set", {key, value}).catch((e) =>
            console.warn(`[kv] write-behind failed for ${key}: ${e}`),
        );
    };

    const shim: Storage = {
        getItem: (key) => (memory.has(key) ? (memory.get(key) as string) : null),
        setItem: (key, value) => {
            memory.set(key, String(value));
            writeBehind(key, String(value));
        },
        removeItem: (key) => {
            memory.delete(key);
            writeBehind(key, null);
        },
        clear: () => {
            for (const key of [...memory.keys()]) shim.removeItem(key);
        },
        key: (index) => [...memory.keys()][index] ?? null,
        get length() {
            return memory.size;
        },
    };
    try {
        Object.defineProperty(window, "localStorage", {
            value: shim,
            configurable: true,
            writable: false,
        });
    } catch (e) {
        console.warn(`[kv] localStorage shim install failed: ${e}`);
    }
}

await installStorage();

// Only now import the app — its module graph reads localStorage at
// evaluation time (persistedStore factory).
await import("./main.tsx");
