/**
 * Typography preferences — the pure side of the custom font / font-size
 * settings (General pane): sanitizing persisted values, building CSS
 * font-family overrides, and applying them to the document root.
 *
 * Runtime override strategy (verified against the compiled Tailwind v4
 * output): `@theme`'s `--font-sans` / `--font-mono` are emitted as real
 * `:root` custom properties and preflight's html font-family resolves
 * through `--default-font-family: var(--font-sans)` — so setting the two
 * vars inline on `document.documentElement` (inline beats `:root`)
 * restyles inherited text, the `font-sans`/`font-mono` utilities, and the
 * `var(--font-mono)` MONO constants in chat cards in one move. A custom
 * family is PREFIXED onto the @theme default stack so missing glyphs
 * (e.g. a Latin-only font receiving CJK) still fall back.
 *
 * Sizes: `uiSizePx` is the root font-size — every rem-based Tailwind
 * utility scales with it (the approved "global zoom" semantics). `codeSizePx`
 * feeds `--lum-code-size`, consumed by the mono surfaces (markdown code,
 * tool cards — see main.css). DOM-touching like glass.ts's token reads;
 * no React, so the math is node-testable.
 */

/** Font family preference — "" means the bundled @theme default stack. */
export interface TypographySettings {
    sansFamily: string;
    monoFamily: string;
    /** Root font-size in px (scales all rem-based text/spacing). */
    uiSizePx: number;
    /** Mono text size in px (markdown code, tool-card lines). */
    codeSizePx: number;
}

export const UI_SIZE_MIN = 12;
export const UI_SIZE_MAX = 20;
export const DEFAULT_UI_SIZE_PX = 16;

export const CODE_SIZE_MIN = 10;
export const CODE_SIZE_MAX = 16;
export const DEFAULT_CODE_SIZE_PX = 12;

export const DEFAULT_TYPOGRAPHY: TypographySettings = {
    sansFamily: "",
    monoFamily: "",
    uiSizePx: DEFAULT_UI_SIZE_PX,
    codeSizePx: DEFAULT_CODE_SIZE_PX,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

function familyOf(value: unknown): string {
    return typeof value === "string" ? value.trim().slice(0, 128) : "";
}

/** Validate/coerce a persisted (possibly corrupt or partial) value. */
export function sanitizeTypography(raw: unknown): TypographySettings {
    if (typeof raw !== "object" || raw === null) return {...DEFAULT_TYPOGRAPHY};
    const r = raw as Record<string, unknown>;
    return {
        sansFamily: familyOf(r.sansFamily),
        monoFamily: familyOf(r.monoFamily),
        uiSizePx: clampInt(r.uiSizePx, UI_SIZE_MIN, UI_SIZE_MAX, DEFAULT_UI_SIZE_PX),
        codeSizePx: clampInt(r.codeSizePx, CODE_SIZE_MIN, CODE_SIZE_MAX, DEFAULT_CODE_SIZE_PX),
    };
}

/** True when nothing deviates from the defaults (nothing to override). */
export function isDefaultTypography(s: TypographySettings): boolean {
    return (
        s.sansFamily === DEFAULT_TYPOGRAPHY.sansFamily &&
        s.monoFamily === DEFAULT_TYPOGRAPHY.monoFamily &&
        s.uiSizePx === DEFAULT_TYPOGRAPHY.uiSizePx &&
        s.codeSizePx === DEFAULT_TYPOGRAPHY.codeSizePx
    );
}

/**
 * Build a CSS font-family list: the requested family (quoted, `"` and `\`
 * escaped) followed by a fallback stack. Empty family → "" (no override).
 */
export function fontFamilyOverride(family: string, fallbackStack: string): string {
    const name = family.trim();
    if (!name) return "";
    const quoted = `"${name.replace(/["\\]/g, "\\$&")}"`;
    const fallback = fallbackStack.trim();
    return fallback ? `${quoted}, ${fallback}` : quoted;
}

/**
 * The @theme default stack for one of the font vars. Clears any inline
 * override first — otherwise the computed read would return our own
 * previous override and we'd prefix onto ourselves.
 */
function themeStack(el: HTMLElement, property: string): string {
    el.style.removeProperty(property);
    return getComputedStyle(el).getPropertyValue(property).trim();
}

/**
 * Apply (or clear, at defaults) the runtime typography overrides on a
 * document root. Idempotent; never throws on unknown values (callers pass
 * sanitized settings).
 */
export function applyTypography(el: HTMLElement, settings: TypographySettings): void {
    const style = el.style;

    const sans = fontFamilyOverride(settings.sansFamily, themeStack(el, "--font-sans"));
    if (sans) style.setProperty("--font-sans", sans);
    else style.removeProperty("--font-sans");

    const mono = fontFamilyOverride(settings.monoFamily, themeStack(el, "--font-mono"));
    if (mono) style.setProperty("--font-mono", mono);
    else style.removeProperty("--font-mono");

    // Root font-size: "" clears the inline override (browser default 16px
    // matches DEFAULT_UI_SIZE_PX, so "default" and "cleared" agree).
    style.fontSize = settings.uiSizePx === DEFAULT_UI_SIZE_PX ? "" : `${settings.uiSizePx}px`;

    if (settings.codeSizePx === DEFAULT_CODE_SIZE_PX) style.removeProperty("--lum-code-size");
    else style.setProperty("--lum-code-size", `${settings.codeSizePx}px`);
}
