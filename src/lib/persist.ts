import {error as logError} from "@tauri-apps/plugin-log";
import type {SessionModelRef} from "../opencode/types.ts";

/**
 * Cross-restart UI state. The webview's localStorage lives in Tauri's app
 * data dir, so it survives quitting the app — enough to land back in the
 * session (or, on the welcome screen, the project) the user left, with the
 * composer's model / thinking depth / mode preselected.
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

const KEY = "lumina-code:ui-state";

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

/** Read the persisted state (never throws; malformed data reads as empty). */
export function loadState(): PersistedState {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return EMPTY;
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
}

/** Write the state (never throws). */
export function saveState(state: PersistedState): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
        logError(`Failed to save UI state: ${e}`).catch(() => {});
    }
}
