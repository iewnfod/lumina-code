import {createPersistedStore} from "../../lib/persistedStore.ts";

/**
 * The composer's NON-REPO acceptance memory: directories the user has
 * explicitly sent through NonGitRepoModal's 无视风险并继续 — the
 * confirmation never re-asks for them (DirectoryPicker's gate short-
 * circuits before the probe). A persisted set (lib/persistedStore.ts,
 * the useSessionPins pattern), app-local per design: the acceptance is
 * a UI decision about risk, not a server-side fact.
 *
 * Initialized-repository verdicts are deliberately NOT recorded — a
 * successful `git init` makes the directory a real repo, so future
 * probes pass on their own.
 */

const store = createPersistedStore<string[]>({
    key: "lumina-code:non-repo-accepted",
    label: "accepted non-repo directories",
    read: (raw) => {
        if (raw == null) return [];
        try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed)
                ? parsed.filter((d): d is string => typeof d === "string")
                : [];
        } catch {
            return [];
        }
    },
    // Empty set persists as absence (a fresh install's storage stays
    // clean — the factory's absence-means-default semantics).
    write: (dirs) => (dirs.length > 0 ? JSON.stringify(dirs) : null),
});

/** Has the user already accepted THIS directory's non-repo risk? */
export function isNonRepoAccepted(directory: string): boolean {
    return store.get().includes(directory);
}

/** Record an acceptance (idempotent). */
export function acceptNonRepoDir(directory: string): void {
    const current = store.get();
    if (current.includes(directory)) return;
    store.set([...current, directory]);
}
