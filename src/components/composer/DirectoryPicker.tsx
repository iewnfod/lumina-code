import {useEffect, useState} from "react";
import {Folder, FolderSearch, GitBranch} from "lucide-react";
import {open as openDialog} from "@tauri-apps/plugin-dialog";
import {warn} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import {useConnection} from "../../opencode/connectionContext.tsx";
import type {OpencodeProject} from "../../opencode/types.ts";
import {folderLabel} from "../../lib/path.ts";
import PopoverMenu, {MenuItem, MenuLabel} from "../ui/PopoverMenu.tsx";
import ToolbarButton from "./ToolbarButton.tsx";
import Hint from "../ui/Hint.tsx";
import {useI18n} from "../../hooks/i18n.tsx";

/**
 * Project-directory picker for the not-yet-started session: quick picks
 * from the server's known projects, plus the native folder picker
 * (Tauri dialog plugin). Choosing `null` keeps the server's default (home).
 */
export default function DirectoryPicker({
    directory,
    onChange,
}: {
    /** Absolute working directory for the next session; null = server default. */
    directory: string | null;
    onChange: (directory: string | null) => void;
}) {
    const colors = useColors();
    const t = useI18n();
    const {api} = useConnection();
    const [projects, setProjects] = useState<OpencodeProject[]>([]);

    // The server's project list accumulates every directory it ever touched
    // (probe runs, deleted sessions, the root, the home itself) and can hold
    // duplicates under different ids. Keep only directories that are real
    // quick-picks: non-root, not the server home, deduped by canonical path,
    // and still hosting at least one root session.
    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        (async () => {
            try {
                const [projects, sessions, location] = await Promise.all([
                    api.listProjects(),
                    api.listSessions(),
                    api.getLocation(),
                ]);
                if (cancelled) return;
                const home = location?.directory;
                const liveDirs = new Set(
                    (sessions ?? [])
                        .filter((s) => !s.parentID)
                        .map((s) => s.directory ?? s.location?.directory)
                        .filter((d): d is string => !!d),
                );
                const byCanonical = new Map<string, OpencodeProject>();
                for (const p of (projects ?? [])
                    .filter((p) =>
                        p.canonical && p.canonical !== "/" && p.canonical !== "." &&
                        p.canonical !== home)
                    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))) {
                    if (liveDirs.size > 0 && !liveDirs.has(p.canonical)) continue;
                    if (!byCanonical.has(p.canonical)) byCanonical.set(p.canonical, p);
                }
                setProjects([...byCanonical.values()].slice(0, 8));
            } catch {
                // Leave the list empty — the native picker still works.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [api]);

    /** Native folder picker (system dialog via the Tauri plugin). */
    const browse = async () => {
        try {
            const chosen = await openDialog({
                directory: true,
                multiple: false,
                title: t["Choose This Folder"],
                defaultPath: directory ?? undefined,
            });
            if (typeof chosen === "string" && chosen.trim() !== "") {
                onChange(chosen);
            }
        } catch (e) {
            warn(`Native folder dialog failed: ${e}`).catch(() => {});
        }
    };

    return (
        <PopoverMenu
            align="start"
            trigger={({open, toggle}) => (
                // The trigger shows only the folder's last segment — the
                // hint carries the full path (nothing to add for the
                // default), idling while the menu is open.
                <Hint label={open ? null : directory}>
                    <ToolbarButton
                        icon={<Folder size={14}/>}
                        label={directory ? folderLabel(directory) : t["Project"]}
                        active={open}
                        onClick={toggle}
                    />
                </Hint>
            )}
        >
            {(close) => (
                <div className="w-64">
                    <MenuItem
                        selected={directory === null}
                        onClick={() => {
                            onChange(null);
                            close();
                        }}
                    >
                        {t["Default project directory"]}
                    </MenuItem>
                    {projects.length > 0 && <MenuLabel>{t["Recent Projects"]}</MenuLabel>}
                    {projects.map((p) => (
                        <div key={p.id}>
                            <MenuItem
                                selected={directory === p.canonical}
                                onClick={() => {
                                    onChange(p.canonical);
                                    close();
                                }}
                            >
                                <span className="inline-flex items-center gap-1.5 min-w-0">
                                    {p.vcs && <GitBranch size={11} className="shrink-0 opacity-50"/>}
                                    <span className="truncate">{folderLabel(p.canonical)}</span>
                                </span>
                            </MenuItem>
                        </div>
                    ))}
                    <div className="my-1 border-t" style={{borderColor: colors.glassBorder}}/>
                    <MenuItem
                        onClick={() => {
                            close();
                            void browse();
                        }}
                    >
                        <span className="inline-flex items-center gap-1.5">
                            <FolderSearch size={13}/>
                            {t["Browse..."]}
                        </span>
                    </MenuItem>
                </div>
            )}
        </PopoverMenu>
    );
}
