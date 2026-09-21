export function isColorDark(hex: string): boolean {
    hex = hex.replace("#", "");
    if (hex.length < 6) return true;
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance < 0.5;
}

/**
 * A readable foreground color for the given background: white on dark, black on
 * light. Used so chrome text (session titles, title bar, settings) follows the
 * effective background even when it changes at runtime.
 */
export function foregroundFor(bg: string): string {
    return isColorDark(bg) ? "#ffffff" : "#000000";
}

export function adjustColor(hex: string, amount: number): string {
    hex = hex.replace("#", "");
    const r = Math.max(0, Math.min(255, parseInt(hex.substring(0, 2), 16) + amount));
    const g = Math.max(0, Math.min(255, parseInt(hex.substring(2, 4), 16) + amount));
    const b = Math.max(0, Math.min(255, parseInt(hex.substring(4, 6), 16) + amount));
    return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Pick a red that stays visible against the effective background, for danger
 * indicators. Falls back to a sensible default if no theme reds are given.
 */
export function visibleRed(
    red: string | undefined,
    brightRed: string | undefined,
    bg: string | undefined,
): string {
    const fallback = "#ef4444";
    const dark = bg ? isColorDark(bg) : true;
    if (dark) {
        // Dark background: the standard red reads well.
        return red ?? brightRed ?? fallback;
    }
    // Light background: brightRed is usually more saturated/visible.
    return brightRed ?? red ?? fallback;
}
