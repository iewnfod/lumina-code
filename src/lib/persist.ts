import {error as logError} from "@tauri-apps/plugin-log";
import type {SessionModelRef} from "../opencode/types.ts";
import {createPersistedStore} from "./persistedStore.ts";

/**
 * Cross-restart UI state. The webview's localStorage lives in Tauri's app
 * data dir, so it survives quitting the app — enough to land back in the
 * session (or, on the welcome screen, the project) the user left, with the
 * composer's model / thinking depth / mode preselected.
 *
 * Implemented over lib/persistedStore.ts like every other persisted
 * preference; unlike them it has no subscribers — useSessionFlow reads it
 * once (first render) and writes it wholesale on change, so this module
 * keeps its loadState/saveState shape.
 */
export interface PersistedState {
    /** Session open at quit; null = the welcome screen. */
    sessionId: string | null;
    /** Composer's model, including the thinking-depth variant. */
    model: SessionModelRef | null;
    /** Composer's mode (primary agent id). */
    agent: string | null;
    /** Welcome screen's staged project directory; null = server default. */
    directory: string | null;
}

const EMPTY: PersistedState = {sessionId: null, model: null, agent: null, directory: null};

function asString(v: unknown): string | null {
    return typeof v === "string" && v !== "" ? v : null;
}

function asModelRef(v: unknown): SessionModelRef | null {
    if (!v || typeof v !== "object") return null;
    const m = v as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.providerID !== "string") return null;
    return {
        id: m.id,
        providerID: m.providerID,
        ...(typeof m.variant === "string" ? {variant: m.variant} : {}),
    };
}

// No eq override: useSessionFlow saves a fresh object literal on every
// change, so reference equality writes each time — the store has no
// subscribers and each write is tiny, exactly the pre-factory behavior.
const store = createPersistedStore<PersistedState>({
    key: "lumina-code:ui-state",
    label: "UI state",
    read: (raw) => {
        if (raw === null) return EMPTY;
        try {
            const v = JSON.parse(raw) as Record<string, unknown>;
            return {
                sessionId: asString(v.sessionId),
                model: asModelRef(v.model),
                agent: asString(v.agent),
                directory: asString(v.directory),
            };
        } catch (e) {
            logError(`Failed to load persisted UI state: ${e}`).catch(() => {});
            return EMPTY;
        }
    },
    write: (state) => JSON.stringify(state),
});

/** Read the persisted state (never throws; malformed data reads as empty). */
export function loadState(): PersistedState {
    return store.get();
}

/** Write the state (never throws). */
export function saveState(state: PersistedState): void {
    store.set(state);
}
