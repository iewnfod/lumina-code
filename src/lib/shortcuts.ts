import type {TranslationKey} from "../i18n/en-us.ts";

/**
 * THE keyboard-shortcut pure core (node-testable, shortcuts.test.ts): the
 * action registry, the chord algebra and the persistence sanitation —
 * everything about shortcuts except WHERE keys are heard (the document
 * listener lives in hooks/useKeyboardShortcuts.ts) and WHERE actions are
 * wired (AppBody).
 *
 * A CHORD is the canonical string form of a key combination:
 * `mod+ctrl+alt+shift+<key>` in that fixed order, all lowercase — e.g.
 * "mod+n", "mod+alt+arrowright", "mod+shift+k", "f2". `mod` is PLATFORM
 * metadata folded at event time: Meta on macOS, Ctrl everywhere else (the
 * fold happens in chordFromEvent, so everything downstream — storage,
 * matching, the settings pane — is platform-blind and stores one shape).
 *
 * WHAT MAY BE BOUND: a chord must carry mod / ctrl / alt (shift alone
 * never qualifies — it would collide with typing), OR be a bare F1–F12
 * key. Escape (the modal/menu close system) and Tab (focus traversal)
 * are reserved, as are the text-editing chords mod(+shift)+a/c/v/x/z/y
 * and the webview-reload pairs mod+r / f5 (the webview may act on them
 * before the page can). Conflicts are ALLOWED — the settings pane warns,
 * and the runtime resolves them deterministically (first action in
 * SHORTCUTS order wins, see matchChord).
 */

/** Every action a shortcut can trigger. Keep SHORTCUTS the single list. */
export type ShortcutAction =
    | "newSession"
    | "toggleSettings"
    | "interruptSession"
    | "nextSession"
    | "prevSession"
    | "focusComposer";

export interface ShortcutDef {
    id: ShortcutAction;
    /** The settings row's label (an i18n key — the pane resolves it). */
    labelKey: TranslationKey;
    /** Default chord; absence in the persisted overrides means this. */
    defaultChord: string;
}

/** The action registry, in MATCH ORDER (a conflicting chord fires the
 *  FIRST action listed here — deterministic, documented in the pane). */
export const SHORTCUTS: readonly ShortcutDef[] = [
    {id: "newSession", labelKey: "New Session", defaultChord: "mod+n"},
    {id: "toggleSettings", labelKey: "Settings", defaultChord: "mod+,"},
    {id: "interruptSession", labelKey: "Stop the running session", defaultChord: "mod+."},
    {id: "nextSession", labelKey: "Next session", defaultChord: "mod+alt+arrowright"},
    {id: "prevSession", labelKey: "Previous session", defaultChord: "mod+alt+arrowleft"},
    {id: "focusComposer", labelKey: "Focus the message box", defaultChord: "mod+l"},
];

// ---------------------------------------------------------------------------
// Keys

/** Keys that are modifiers themselves — a chord can never END in one. */
const MODIFIER_KEYS = new Set(["shift", "control", "ctrl", "alt", "meta", "os"]);

/** Multi-character key names that may sit at a chord's tail. Single
 *  characters (letters, digits, punctuation, space) are legal as-is. */
const NAMED_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "enter"]);
for (let i = 1; i <= 12; i++) NAMED_KEYS.add(`f${i}`);

/** e.key values that carry no binding meaning (IME / undetermined). */
const UNUSABLE_KEYS = new Set(["dead", "process", "unidentified"]);

/** Normalize a KeyboardEvent `key` into a chord tail: single characters
 *  lowercase, named keys as-is (already lowercase), unusable → null. */
function normalizeEventKey(key: string): string | null {
    if (key.length === 1) {
        // "+" cannot round-trip through the "+"-separated chord form.
        return key === "+" ? null : key.toLowerCase();
    }
    const named = key.toLowerCase();
    return UNUSABLE_KEYS.has(named) ? null : named;
}

/** Is `key` a legal chord tail (per NAMED_KEYS + single-character rules)? */
function isValidKey(key: string): boolean {
    if (key.length === 1) return /\S/.test(key) && key !== "+";
    return NAMED_KEYS.has(key);
}

// ---------------------------------------------------------------------------
// Event → chord

/** The KeyboardEvent shape chordFromEvent needs (structural, so tests and
 *  the recording pane can feed plain objects). */
export interface ChordEventParts {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    /** IME composition in flight — never bind. */
    isComposing?: boolean;
}

/** Fold a keyboard event into its canonical chord, or null when the event
 *  is not bindable at all (IME, bare plain key, pure modifier press, the
 *  non-mac Super key — that one belongs to the OS, not the app).
 *
 *  Platform folding: `mod` = Meta on macOS / Ctrl elsewhere; an EXPLICIT
 *  Ctrl on mac survives as its own "ctrl" segment (mac users may want
 *  genuinely-Ctrl chords), while Meta on non-mac aborts the match. */
export function chordFromEvent(e: ChordEventParts, isMac: boolean): string | null {
    if (e.isComposing) return null;
    const key = normalizeEventKey(e.key);
    if (key === null) return null;
    if (MODIFIER_KEYS.has(key)) return null;
    if (!isMac && e.metaKey) return null;

    const mod = isMac ? e.metaKey : e.ctrlKey;
    const ctrl = isMac && e.ctrlKey;
    const alt = e.altKey;
    const shift = e.shiftKey;

    // Bindable gate: a real modifier, or a bare F-key.
    if (!mod && !ctrl && !alt && !/^f([1-9]|1[0-2])$/.test(key)) return null;

    const parts: string[] = [];
    if (mod) parts.push("mod");
    if (ctrl) parts.push("ctrl");
    if (alt) parts.push("alt");
    if (shift) parts.push("shift");
    parts.push(key);
    return parts.join("+");
}

// ---------------------------------------------------------------------------
// Chord parsing / validation

export interface ParsedChord {
    mods: {mod: boolean; ctrl: boolean; alt: boolean; shift: boolean};
    key: string;
}

/** Parse a canonical chord string. Null when malformed (empty segments,
 *  unknown/duplicated modifiers, illegal tail). LENIENT about reserved
 *  keys — parse says "is a chord", isBindableChord says "may be bound"
 *  (the pane wants to DISPLAY escape-shaped storage garbage as invalid
 *  rather than crash, and matching never reserves). */
export function parseChord(chord: string): ParsedChord | null {
    if (typeof chord !== "string" || chord.length === 0) return null;
    const segments = chord.split("+");
    const key = segments.pop();
    if (key === undefined || !isValidKey(key)) return null;
    const mods = {mod: false, ctrl: false, alt: false, shift: false};
    for (const segment of segments) {
        if (segment === "mod") {
            if (mods.mod) return null;
            mods.mod = true;
        } else if (segment === "ctrl") {
            if (mods.ctrl) return null;
            mods.ctrl = true;
        } else if (segment === "alt") {
            if (mods.alt) return null;
            mods.alt = true;
        } else if (segment === "shift") {
            if (mods.shift) return null;
            mods.shift = true;
        } else {
            return null;
        }
    }
    return {mods, key};
}

/** Text-editing chords the whole OS reserves for inputs: exactly one of
 *  mod/ctrl held (⌘A and ⌃A both select), no alt — a binding here would
 *  shadow copy/paste/cut/undo/redo/select-all mid-typing. */
const RESERVED_TEXT_KEYS = new Set(["a", "c", "v", "x", "z", "y", "r"]);

/** May this chord be BOUND? Complements parseChord: reserved keys and the
 *  webview's own reload pairs are refused here. Three gates, mirroring
 *  the file doc: (1) escape/tab are the app's dismissal/traversal keys;
 *  (2) the bindable-shape gate from chordFromEvent (a real modifier, or
 *  a bare F1–F12 — rejects plain/shift-only letters that hand-written
 *  storage could carry); (3) the text-editing/reload family: mod or
 *  mac-ctrl (+ any shift, no alt) with a reserved letter. */
export function isBindableChord(chord: string): boolean {
    const parsed = parseChord(chord);
    if (parsed === null) return false;
    const {mods, key} = parsed;
    if (key === "escape" || key === "tab") return false;
    if (key === "f5") return false;
    const hasModifier = mods.mod || mods.ctrl || mods.alt;
    if (!hasModifier && !/^f([1-9]|1[0-2])$/.test(key)) return false;
    // Text family: EXACTLY ONE of mod/mac-ctrl held (⌘A / ⌃A both select),
    // no alt, + a reserved letter. Both held together (⌘⌃A) is exotic and
    // nobody's text shortcut.
    const held = (mods.mod ? 1 : 0) + (mods.ctrl ? 1 : 0);
    if (held === 1 && !mods.alt && RESERVED_TEXT_KEYS.has(key)) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Bindings

/** Effective bindings: every action → its chord (custom override ?? the
 *  registry default; invalid overrides fall back to the default too — the
 *  persisted read side sanitizes, but callers may pass anything). */
export function resolveBindings(
    custom: Readonly<Partial<Record<ShortcutAction, string>>>,
): Record<ShortcutAction, string> {
    const out = {} as Record<ShortcutAction, string>;
    for (const def of SHORTCUTS) {
        const chord = custom[def.id];
        out[def.id] = typeof chord === "string" && parseChord(chord) !== null ? chord : def.defaultChord;
    }
    return out;
}

/** Which action does this event chord fire? FIRST registry match wins —
 *  the documented conflict rule (the pane warns, this stays deterministic). */
export function matchChord(
    chord: string | null,
    bindings: Readonly<Record<ShortcutAction, string>>,
): ShortcutAction | null {
    if (chord === null) return null;
    for (const def of SHORTCUTS) {
        if (bindings[def.id] === chord) return def.id;
    }
    return null;
}

/** chord → the actions bound to it (length > 1 = conflict). The settings
 *  pane's warning source. */
export function findConflicts(
    bindings: Readonly<Record<ShortcutAction, string>>,
): Map<string, ShortcutAction[]> {
    const map = new Map<string, ShortcutAction[]>();
    for (const def of SHORTCUTS) {
        const chord = bindings[def.id];
        const bucket = map.get(chord);
        if (bucket) bucket.push(def.id);
        else map.set(chord, [def.id]);
    }
    return map;
}

/** Sanitize an UNTRUSTED value into custom overrides (the persisted
 *  store's read side): unknown actions, non-strings and malformed chords
 *  are dropped — never throws. */
export function sanitizeCustomBindings(raw: unknown): Partial<Record<ShortcutAction, string>> {
    const out: Partial<Record<ShortcutAction, string>> = {};
    if (raw === null || typeof raw !== "object") return out;
    const known = new Set(SHORTCUTS.map((def) => def.id));
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!known.has(id as ShortcutAction)) continue;
        if (typeof value !== "string") continue;
        if (parseChord(value) === null) continue;
        out[id as ShortcutAction] = value;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Display

/** Tail-key display forms (everything else shows as typed / uppercased). */
const KEY_DISPLAY: Record<string, string> = {
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    enter: "↩",
};

/** Human display: "⌘⇧N" on mac, "Ctrl+Shift+N" elsewhere. Unknown chords
 *  pass through unchanged (the pane never renders them — resolveBindings
 *  guarantees valid chords — but display never crashes). */
export function formatChord(chord: string, isMac: boolean): string {
    const parsed = parseChord(chord);
    if (parsed === null) return chord;
    const {mods, key} = parsed;
    const keyLabel =
        KEY_DISPLAY[key] ??
        (key.length === 1 || /^f([1-9]|1[0-2])$/.test(key) ? key.toUpperCase() : key);
    if (isMac) {
        let out = "";
        if (mods.mod) out += "⌘";
        if (mods.ctrl) out += "⌃";
        if (mods.alt) out += "⌥";
        if (mods.shift) out += "⇧";
        return out + keyLabel;
    }
    const parts: string[] = [];
    if (mods.mod) parts.push("Ctrl");
    if (mods.ctrl) parts.push("Ctrl");
    if (mods.alt) parts.push("Alt");
    if (mods.shift) parts.push("Shift");
    parts.push(keyLabel);
    return parts.join("+");
}
