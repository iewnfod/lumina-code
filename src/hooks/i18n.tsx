import {useSyncExternalStore} from "react";
import enUs, {type TranslationKey} from "../i18n/en-us.ts";
import zhCn from "../i18n/zh-cn.ts";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * Minimal i18n store. `useI18n()` keeps lumina-terminal's signature — it
 * returns a plain dictionary the caller indexes with a TranslationKey — but
 * the dictionary is resolved from the active language instead of being
 * hardwired to en-us.
 *
 * Language resolution: the user's persisted choice (a store over
 * lib/persistedStore.ts; null — an absent key — means follow the system)
 * wins; otherwise the system language (the webview's locale mirrors the
 * OS setting) is used; anything unrecognized falls back to English. A
 * missing zh-CN key also falls back to English per-lookup, so
 * translations can land incrementally.
 */

export type {TranslationKey};

export type Language = "en-us" | "zh-cn";

const TABLES: Record<Language, Partial<Record<TranslationKey, string>>> = {
    "en-us": enUs,
    "zh-cn": zhCn,
};

/** User's explicit choice; null = follow the system language. */
const choice = createPersistedStore<Language | null>({
    key: "lumina-code:language",
    label: "language choice",
    read: (raw) => (raw === "en-us" || raw === "zh-cn" ? raw : null),
    write: (lang) => lang,
});

/** System language, resolved once at startup. */
const system: Language | null = detectSystem();

function detectSystem(): Language | null {
    const lang = navigator.language?.toLowerCase() ?? "";
    return lang.startsWith("zh") ? "zh-cn" : null;
}

// Resolved dictionaries are cached per language so useSyncExternalStore's
// snapshot keeps a stable identity between renders.
const resolvedCache = new Map<Language | null, Record<TranslationKey, string>>();

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

/** The hook stays dictionary-shaped: `t["New Session"]`. */
export function useI18n(): Record<TranslationKey, string> {
    return useSyncExternalStore(choice.subscribe, () => resolveTable(choice.get() ?? system));
}

/** The STORED choice, reactive. The dictionary store above can't drive a
 *  choice picker: two choices may resolve to the SAME cached table (an
 *  explicit "zh-cn" vs follow-system on a zh system), so its snapshot is
 *  identical across the switch and React bails out of the re-render. This
 *  snapshot is the raw stored primitive — it changes on every switch. */
export function useLanguageChoice(): Language | null {
    return useSyncExternalStore(choice.subscribe, choice.get);
}

/** The language the dictionary actually resolves to right now (explicit
 *  choice → system language → en-us). For consumers whose content pools
 *  are keyed by language (greetings) rather than looked up per-string. */
export function resolvedLanguage(): Language {
    return choice.get() ?? system ?? "en-us";
}

/** Switch language and persist the choice; null clears it back to
 *  follow-the-system. Never throws. */
export function setLanguage(lang: Language | null): void {
    choice.set(lang);
}
