import type {PermissionRule, SavedPermission} from "./types.ts";
import type {TranslationKey} from "../i18n/en-us.ts";

/**
 * THE PERMISSION MODE LADDER (spike-verified against server v2.0.11 —
 * see the quirks inline; the official docs drift from the binary).
 *
 * A mode is a small FIXED "fingerprint" rule set Lumina Code appends to the
 * END of a project config's `permissions` array. Rules merge last-match-wins
 * (spike: project rules land AFTER the built-in base policy and AFTER the
 * built-in agent add-ons, so the fingerprint decides), while agent-section
 * denies (e.g. lumina-daily's bash deny, spike: they land AFTER project
 * rules) still win over anything we write — a mode can never unlock them.
 *
 * WHY the fingerprint is written at all for `strict`: the server's built-in
 * base policy is `* / * → allow` (+ `.env` asks, + `external_directory * →
 * ask` — the docs claim the default there is `allow`, but the binary ships
 * `ask`), so "no rules" is a PERMISSIVE state, not a strict one. A directory
 * with no fingerprint is *identified* as strict (the safe fallback the user
 * chose) and callers SELF-HEAL it to disk so the display never lies about
 * behavior. See projectPermissions.ts.
 *
 * Known accepted edge (spike): the plan agent's built-in `edit * → deny`
 * loads BEFORE project rules, so `strict`'s `edit * → ask` overrides it —
 * plan flips from "refuse edits" to "ask the user", which matches strict's
 * everything-asks intent. Plan documents are written by the plugin executor
 * through node:fs, unaffected.
 */

export type PermissionModeId = "strict" | "balanced" | "full";

/** One mode's ordered fingerprint — the exact array written to config. */
export const PERMISSION_MODE_RULES: Record<PermissionModeId, readonly PermissionRule[]> = {
    /** 任何变更前需确认：every mutation (edits, commands, external paths)
     * asks. THE fallback mode — no fingerprint in config also reads as
     * this (virtually, until self-healed to disk). */
    strict: [
        {action: "edit", resource: "*", effect: "ask"},
        {action: "external_directory", resource: "*", effect: "ask"},
        {action: "shell", resource: "*", effect: "ask"},
    ],
    /** 有风险时需确认：in-project edits pass; commands and anything
     * outside the project ask (`.env` stays asked via the built-in
     * policy). Saved approvals ("always allow" → e.g. `git status *`)
     * cover the ask so routine commands don't nag — spike-verified that a
     * saved allow beats a configured ask, never a deny. */
    balanced: [
        {action: "external_directory", resource: "*", effect: "ask"},
        {action: "shell", resource: "*", effect: "ask"},
    ],
    /** 完全访问：nothing asks — the `.env` overrides are required because
     * the built-in base policy asks for them; `external_directory * →
     * allow` is explicit (it is the built-in `ask` flipped). */
    full: [
        {action: "external_directory", resource: "*", effect: "allow"},
        {action: "read", resource: "*.env", effect: "allow"},
        {action: "read", resource: "*.env.*", effect: "allow"},
        {action: "shell", resource: "*", effect: "allow"},
    ],
};

/** The ordered mode list as the picker shows it (strict first: the safe
 * default). */
export const PERMISSION_MODE_ORDER: readonly PermissionModeId[] = ["strict", "balanced", "full"];

const sameRule = (a: PermissionRule, b: PermissionRule) =>
    a.action === b.action && a.resource === b.resource && a.effect === b.effect;

/** Every rule any fingerprint may contain (membership test for the
 * strip-then-append rewrite). */
const ALL_FINGERPRINT_RULES: readonly PermissionRule[] = PERMISSION_MODE_ORDER.flatMap(
    (mode) => PERMISSION_MODE_RULES[mode],
);

export function isFingerprintRule(rule: PermissionRule): boolean {
    return ALL_FINGERPRINT_RULES.some((f) => sameRule(f, rule));
}

/**
 * Which mode a config's `permissions` array currently expresses. A mode
 * counts when its whole fingerprint is present ANYWHERE in the array
 * (strict ⊇ balanced, so strict is tested first — the largest match wins).
 * NO fingerprint found → `"strict"` (the virtual fallback; callers
 * self-heal it to disk so behavior matches the display).
 */
export function identifyPermissionMode(rules: PermissionRule[] | undefined | null): PermissionModeId {
    const list = rules ?? [];
    // Largest fingerprint first: strict (3) before balanced (2). `full`
    // shares no rules with the others.
    for (const mode of PERMISSION_MODE_ORDER) {
        const fingerprint = PERMISSION_MODE_RULES[mode];
        if (fingerprint.every((f) => list.some((r) => sameRule(r, f)))) return mode;
    }
    return "strict";
}

/** How many rules in the array are NOT part of any fingerprint — the
 * "另有 N 条手动规则" hint (hand-written repo/user rules we always
 * preserve verbatim). */
export function manualRuleCount(rules: PermissionRule[] | undefined | null): number {
    return (rules ?? []).filter((r) => !isFingerprintRule(r)).length;
}

/**
 * The rewrite for switching modes: strip EVERY fingerprint member (ours and
 * look-alikes — a hand-written `shell * → ask` is semantically what the
 * fingerprint re-declares anyway), keep all other rules in place, append
 * the target fingerprint at the END (last-match-wins ⇒ the mode decides
 * for its actions; unrelated manual rules like `git push → deny` keep
 * working). Switching TO strict still writes strict's rules — "no rules"
 * is permissive on this server, so strict must be real.
 */
export function applyPermissionMode(
    rules: PermissionRule[] | undefined | null,
    mode: PermissionModeId,
): PermissionRule[] {
    const kept = (rules ?? []).filter((r) => !isFingerprintRule(r));
    return [...kept, ...PERMISSION_MODE_RULES[mode]];
}

/** Saved approvals newest-first (the revoke list's order). */
export function sortSavedPermissions(list: SavedPermission[]): SavedPermission[] {
    return [...list].sort((a, b) => b.time.created - a.time.created);
}

/** i18n key describing what an action IS (shared by the request cards and
 * the approved-access list). null = no phrase; callers fall back to the
 * raw action name. */
export function permissionActionLabelKey(action: string): TranslationKey | null {
    switch (action) {
        case "external_directory": return "Access a folder outside the project";
        case "bash": case "shell": return "Run a shell command";
        case "edit": case "apply_patch": case "patch": return "Edit a file";
        case "write": return "Write a file";
        case "read": return "Read files";
        case "glob": return "Search for files";
        case "grep": return "Search file contents";
        case "webfetch": return "Fetch a web page";
        case "websearch": return "Search the web";
        case "question": return "Question";
        default: return null;
    }
}
