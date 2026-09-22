import {useSyncExternalStore} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import enUs, {type TranslationKey} from "../i18n/en-us.ts";
import zhCn from "../i18n/zh-cn.ts";

/**
 * Minimal i18n store. `useI18n()` keeps lumina-terminal's signature — it
 * returns a plain dictionary the caller indexes with a TranslationKey — but
 * the dictionary is now resolved from the active language instead of being
 * hardwired to en-us.
 *
 * Language resolution: the user's persisted choice wins; otherwise the
 * system language (the webview's locale mirrors the OS setting) is used;
 * anything unrecognized falls back to English. A missing zh-CN key also
 * falls back to English per-lookup, so translations can land incrementally.
 */

export type {TranslationKey};

export type Language = "en-us" | "zh-cn";

const TABLES: Record<Language, Partial<Record<TranslationKey, string>>> = {
    "en-us": enUs,
    "zh-cn": zhCn,
};

const STORAGE_KEY = "lumina-code:language";

/** User's explicit choice; null = follow the system language. */
let stored: Language | null = loadStored();
/** System language, resolved once at startup. */
let system: Language | null = detectSystem();

const listeners = new Set<() => void>();

// Resolved dictionaries are cached per language so useSyncExternalStore's
// snapshot keeps a stable identity between renders.
const resolvedCache = new Map<Language | null, Record<TranslationKey, string>>();

function loadStored(): Language | null {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        return v === "en-us" || v === "zh-cn" ? v : null;
    } catch {
        return null;
    }
}

function detectSystem(): Language | null {
    const lang = navigator.language?.toLowerCase() ?? "";
    return lang.startsWith("zh") ? "zh-cn" : null;
}

function resolveTable(lang: Language | null): Record<TranslationKey, string> {
    if (lang === null || lang === "en-us") return enUs;
    let table = resolvedCache.get(lang);
    if (!table) {
        const overrides = TABLES[lang];
        table = {} as Record<TranslationKey, string>;
        for (const key of Object.keys(enUs) as TranslationKey[]) {
            table[key] = overrides[key] ?? enUs[key];
        }
        resolvedCache.set(lang, table);
    }
    return table;
}

let snapshot = resolveTable(stored ?? system);

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getSnapshot(): Record<TranslationKey, string> {
    return snapshot;
}

/** The hook stays dictionary-shaped: `t["New Session"]`. */
export function useI18n(): Record<TranslationKey, string> {
    return useSyncExternalStore(subscribe, getSnapshot);
}

/** The effective language, or null while following the system. */
export function currentLanguage(): Language | null {
    return stored;
}

/** Switch language and persist the choice; null clears it back to
 *  follow-the-system. Never throws. */
export function setLanguage(lang: Language | null): void {
    stored = lang;
    try {
        if (lang === null) {
            localStorage.removeItem(STORAGE_KEY);
        } else {
            localStorage.setItem(STORAGE_KEY, lang);
        }
    } catch (e) {
        logError(`Failed to persist language choice: ${e}`).catch(() => {});
    }
    snapshot = resolveTable(stored ?? system);
    for (const listener of listeners) listener();
}
