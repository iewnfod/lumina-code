/**
 * Blur my Shell integration — the pure decision layer over the Rust
 * probe's raw snapshot (`src-tauri/src/blur.rs` runs the gsettings IO).
 * node-testable; keep this file free of React/Tauri imports.
 *
 * How the extension matches windows (mirrors `wildcardToRegex` in its
 * `src/components/applications.js`, master-era): the window's
 * wm_class/app_id is tested against whitelist patterns where `*` matches
 * any sequence and `?` any single character, case-insensitively; every
 * other character is literal (regex metacharacters in a pattern must NOT
 * gain meaning). Deriving our status and composing the whitelist entry
 * both build on that one matcher.
 */

/** The raw state the Rust probe reports (serde camelCase). */
export interface BlurSnapshot {
    gnome: boolean;
    installed: boolean;
    /** The extension is enabled in the shell — a present-but-disabled
     *  extension never blurs, so this gates the whole chain. */
    extensionEnabled: boolean;
    blur: boolean;
    enableAll: boolean;
    staticBlur: boolean;
    opacity: number;
    whitelist: string[];
    blacklist: string[];
    wmClass: string;
}

export type BlurStatus =
    | {state: "unsupported"}
    | {state: "notInstalled"}
    | {state: "extensionDisabled"}
    | {state: "disabled"}
    | {state: "notListed"}
    | {state: "blacklisted"}
    | {state: "active"; staticBlur: boolean; opacity: number};

/**
 * Test a wm_class against one BMS pattern. Mirrors the extension's
 * wildcard semantics: `*` → any sequence, `?` → one char, everything
 * else escaped to a literal, whole-string match, case-insensitive.
 */
export function bmsWildcardMatch(pattern: string, value: string): boolean {
    if (!pattern || !value) return false;
    const escaped = pattern.replace(/[.+^${}()|[\]\\?*]/g, (ch) => {
        if (ch === "*") return ".*";
        if (ch === "?") return ".";
        return "\\" + ch;
    });
    return new RegExp(`^${escaped}$`, "i").test(value);
}

function matchesAny(patterns: string[], value: string): boolean {
    return patterns.some((p) => bmsWildcardMatch(p, value));
}

/**
 * Derive the user-facing status from a snapshot, following the
 * extension's own decision chain (`check_blur` in applications.js) plus
 * the reachability gates the Rust probe reports: GNOME → schema
 * reachable → extension ENABLED → applications blur enabled →
 * (enable-all ? not blacklisted : whitelisted).
 */
export function deriveBmsStatus(snapshot: BlurSnapshot): BlurStatus {
    if (!snapshot.gnome || !snapshot.installed) {
        return snapshot.gnome ? {state: "notInstalled"} : {state: "unsupported"};
    }
    if (!snapshot.extensionEnabled) return {state: "extensionDisabled"};
    if (!snapshot.blur) return {state: "disabled"};
    if (snapshot.enableAll) {
        return matchesAny(snapshot.blacklist, snapshot.wmClass)
            ? {state: "blacklisted"}
            : {state: "active", staticBlur: snapshot.staticBlur, opacity: snapshot.opacity};
    }
    if (matchesAny(snapshot.whitelist, snapshot.wmClass)) {
        return {state: "active", staticBlur: snapshot.staticBlur, opacity: snapshot.opacity};
    }
    return {state: "notListed"};
}

/**
 * Compose the whitelist to write: the existing entries plus our
 * wmClass — unless an existing pattern already matches it (a literal
 * `lumina-code` entry, or a wildcard like `lum*`), in which case the
 * list comes back unchanged so we never accumulate near-duplicates.
 */
export function composeWhitelist(existing: string[], wmClass: string): string[] {
    if (matchesAny(existing, wmClass)) return existing;
    return [...existing, wmClass];
}

/**
 * The render decision for the translucent compositor-blur material:
 * the user's preference AND at least one blur provider live. The
 * NATIVE ext-background-effect-v1 path (Mutter 51 / KWin 6.7+ /
 * COSMIC — the protocol global probe) takes priority; the Blur my
 * Shell chain is the fallback for older GNOME. `nativeAvailable`
 * implies the whole render path is safe: App paints the window base
 * translucent and the compositor blurs behind the whole window
 * (glass.ts's compositorBlur option) — the store that feeds this
 * (useBlurMyShell.ts) only reports available when the effect can
 * actually be driven, falling back to opaque otherwise.
 */
export function deriveBlurActive(
    nativeAvailable: boolean,
    bms: BlurStatus,
    enabled: boolean,
): boolean {
    return enabled && (nativeAvailable || bms.state === "active");
}
