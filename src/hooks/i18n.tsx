/**
 * Minimal i18n shim. lumina-terminal reads the dictionary from its persisted
 * config; lumina-code has no config system yet, so this returns the en-us
 * table directly. The signature matches lumina-terminal's useI18n so ported
 * components (TitleBar, …) stay byte-identical — swap in the real language
 * machinery when settings land.
 */
const enUs = {
    "Command Palette": "Command Palette",
    "Pin on Top": "Pin on Top",
    "Unpin from Top": "Unpin from Top",
    "Always on top is not supported on Wayland": "Always on top is not supported on Wayland",
    "New Session": "New Session",
    "Welcome to Lumina Code": "Welcome to Lumina Code",
    "Create a session to start": "Create a session to start",
    "Connecting to OpenCode…": "Connecting to OpenCode…",
    "Connection error": "Connection error",
} as const;

export type TranslationKey = keyof typeof enUs;

export function useI18n() {
    return enUs;
}
