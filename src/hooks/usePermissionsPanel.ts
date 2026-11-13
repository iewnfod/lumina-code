import {useCallback, useEffect, useRef, useState} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import {useConnection} from "../opencode/connectionContext.tsx";
import {useAppMode} from "../opencode/appMode.ts";
import {resolveDefaultWorkspace} from "../opencode/defaultWorkspace.ts";
import type {OpencodeApi} from "../opencode/api.ts";
import {projectIdForDirectory} from "../opencode/worktreeSessions.ts";
import {
    readProjectPermissions,
    writeProjectPermissionMode,
} from "../opencode/projectPermissions.ts";
import {sortSavedPermissions, type PermissionModeId} from "../opencode/permissionModes.ts";
import type {SavedPermission} from "../opencode/types.ts";

/**
 * The permission picker's STATE half (the picker itself lives in
 * components/composer/PermissionPicker.tsx): what the directory's config
 * expresses (mode + manual rule count + block reasons), the mode switch
 * (projectPermissions.ts's locked read-merge-write), and the directory's
 * saved approvals (list + optimistic revoke).
 *
 * THE VIRTUAL-STRICT SELF-HEAL: the user-facing ladder has no "default"
 * rung — a directory without a fingerprint IS strict. But "no rules" is a
 * permissive state on the server (the built-in base policy allows
 * everything except `.env`), so displaying strict without writing it would
 * lie about behavior. Whenever a read comes back strict we best-effort
 * write the strict fingerprint ONCE per app run per directory (the write
 * is idempotent — a directory that already carries the fingerprint just
 * gets it re-declared); failures log and retry on the next entry.
 *
 * Refresh triggers: `permission.replied` (a new "always allow" may have
 * landed) and `config.updated` (any config write — ours included, plus
 * hand edits in an editor) re-pull, debounced; the api identity and the
 * directory itself are effect deps.
 */

/** Directories already self-healed (or explicitly switched) this app run —
 * caps the heal to one write per directory, per run. */
const healedDirs = new Set<string>();

export interface PermissionsPanelState {
    /** False when there is no target directory (dev welcome without a
     * staged project / failed daily resolve) — the permission section
     * must not render, but the hook stays mountable at the button level
     * (the toolbar label reads it). */
    available: boolean;
    /** Current mode; null while loading or when the panel is unusable
     * (no api / no directory / blocked read). */
    mode: PermissionModeId | null;
    /** Manual (non-fingerprint) rules in the config — the "N 条手动规则" hint. */
    manualCount: number;
    /** Why the config can't be read (parse = comments/garbage, probe =
     * read failed). Null when readable. */
    blockedReason: "parse" | "probe" | null;
    /** The config document refuses machine writes (JSONC) — switching
     * shows the manual-edit hint instead. */
    jsonc: boolean;
    switching: boolean;
    /** The directory's saved approvals, newest first. */
    saved: SavedPermission[];
    /** Switch to a mode (locked read-merge-write; outcome logged). */
    switchMode: (mode: PermissionModeId) => Promise<void>;
    /** Revoke one saved approval; optimistic, 404-tolerant (already gone). */
    revoke: (id: string) => Promise<void>;
}

export function usePermissionsPanel(directory: string | null): PermissionsPanelState {
    const {api, subscribe} = useConnection();
    const [available, setAvailable] = useState(directory !== null);
    const [mode, setMode] = useState<PermissionModeId | null>(null);
    const [manualCount, setManualCount] = useState(0);
    const [blockedReason, setBlockedReason] = useState<"parse" | "probe" | null>(null);
    const [jsonc, setJsonc] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [saved, setSaved] = useState<SavedPermission[]>([]);
    const switchingRef = useRef(false);

    // The mode read + virtual-strict self-heal. Re-runs on api/directory.
    useEffect(() => {
        setAvailable(directory !== null);
        if (!api || !directory) {
            setMode(null);
            setBlockedReason(null);
            setJsonc(false);
            setManualCount(0);
            return;
        }
        let cancelled = false;
        readProjectPermissions(api, directory).then(async (state) => {
            if (cancelled) return;
            if (state.kind === "blocked") {
                setMode(null);
                setBlockedReason(state.reason);
                return;
            }
            setMode(state.mode);
            setManualCount(state.manualCount);
            setJsonc(state.target.jsonc);
            // Self-heal the virtual strict once per run per directory.
            if (state.mode === "strict" && !healedDirs.has(directory) && !state.target.jsonc) {
                healedDirs.add(directory);
                const heal = await writeProjectPermissionMode(api, directory, "strict");
                if (heal.ok) {
                    logInfo(`Permission mode self-healed to strict for ${directory}`).catch(() => {});
                } else {
                    logError(`Permission mode self-heal failed (${heal.reason}) for ${directory}`).catch(() => {});
                }
            }
        }).catch((e) => {
            if (!cancelled) {
                setMode(null);
                setBlockedReason("probe");
                logError(`Failed to read permission mode for ${directory}: ${e}`).catch(() => {});
            }
        });
        return () => {
            cancelled = true;
        };
    }, [api, directory]);

    // The saved-approvals list for this directory's project.
    useEffect(() => {
        if (!api || !directory) {
            setSaved([]);
            return;
        }
        let cancelled = false;
        const pull = () => {
            Promise.all([api.listSavedPermissions(), api.listProjects()])
                .then(([all, projects]) => {
                    if (cancelled) return;
                    const projectID = projectIdForDirectory(projects, directory);
                    setSaved(sortSavedPermissions(
                        projectID ? all.filter((s) => s.projectID === projectID) : [],
                    ));
                })
                .catch((e) => {
                    logError(`Failed to load saved permissions for ${directory}: ${e}`).catch(() => {});
                });
        };
        pull();
        // Debounced refresh: reply events land a new "always allow";
        // config writes may change everything. One pull per burst.
        let timer: ReturnType<typeof setTimeout> | null = null;
        const bounce = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(pull, 300);
        };
        const off = subscribe((event) => {
            if (event.type === "permission.replied" || event.type === "config.updated") bounce();
        });
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            off();
        };
    }, [api, directory, subscribe]);

    const switchMode = useCallback(async (next: PermissionModeId) => {
        const a: OpencodeApi | null = api;
        if (!a || !directory || switchingRef.current) return;
        switchingRef.current = true;
        setSwitching(true);
        try {
            const result = await writeProjectPermissionMode(a, directory, next);
            if (result.ok) {
                healedDirs.add(directory);
                setMode(next);
                logInfo(`Permission mode switched to ${next} for ${directory}`).catch(() => {});
            } else {
                logError(`Permission mode switch to ${next} refused (${result.reason}) for ${directory}`).catch(() => {});
                // Re-read so the picker reflects the truth (e.g. jsonc).
                const state = await readProjectPermissions(a, directory);
                if (state.kind === "ok") {
                    setMode(state.mode);
                    setJsonc(state.target.jsonc);
                }
            }
        } finally {
            switchingRef.current = false;
            setSwitching(false);
        }
    }, [api, directory]);

    const revoke = useCallback(async (id: string) => {
        const a: OpencodeApi | null = api;
        if (!a) return;
        // Optimistic remove; restore on failure unless it was already gone.
        const prev = saved;
        setSaved((list) => list.filter((s) => s.id !== id));
        try {
            await a.removeSavedPermission(id);
        } catch (e) {
            const gone = (e as {status?: number}).status === 404;
            if (!gone) {
                setSaved(prev);
                logError(`Failed to revoke saved permission ${id}: ${e}`).catch(() => {});
            }
        }
    }, [api, saved]);

    return {available, mode, manualCount, blockedReason, jsonc, switching, saved, switchMode, revoke};
}

/**
 * Which directory the permission ladder targets: DEV uses the staged
 * (welcome) / current (session) project directory; DAILY always targets
 * the WORKSPACE ROOT (resolved from the live server — its cwd = $HOME;
 * a failed resolve degrades to null, never a guessed path). Extracted
 * from the menu so the merged Mode BUTTON can host the panel state
 * (its label shows the active rung) while the menu renders it.
 */
export function usePermissionDirectory(directory: string | null): string | null {
    const appMode = useAppMode();
    const {api} = useConnection();
    const [dailyWorkspace, setDailyWorkspace] = useState<string | null>(null);
    useEffect(() => {
        if (appMode !== "daily" || !api) return;
        let cancelled = false;
        resolveDefaultWorkspace(api).then((p) => {
            if (!cancelled) setDailyWorkspace(p);
        });
        return () => {
            cancelled = true;
        };
    }, [appMode, api]);
    return appMode === "daily" ? dailyWorkspace : directory;
}
