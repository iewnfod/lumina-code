import {type CSSProperties} from "react";
import {FolderInput} from "lucide-react";
import Modal from "./ui/Modal.tsx";
import Button from "./ui/Button.tsx";
import Hint from "./ui/Hint.tsx";
import {ExitList} from "./ui/ExitPresence.tsx";
import {useColors} from "../hooks/colors.tsx";
import {useNow} from "../hooks/useNow.ts";
import {useI18n} from "../hooks/i18n.tsx";
import {useScrollEdges} from "../hooks/useScrollEdges.ts";
import {usePhoneLayout} from "../hooks/useLayoutMode.ts";
import {folderLabel} from "../lib/path.ts";
import {groupByDirectory, relativeAge, type SessionInfo} from "./sessionGrouping.ts";
import {useSessionData} from "../opencode/sessionDataContext.tsx";
import {sessionMode} from "../opencode/appMode.ts";
import {useWorktreeDirs} from "../opencode/worktreeSessions.ts";

/**
 * The session-import picker: sessions that exist in the shared OpenCode
 * storage but were created OUTSIDE this app (the TUI/CLI, other desktop
 * instances — the registry whitelist keeps them out of the sidebar
 * otherwise). Importing only grants whitelist membership
 * (useSessions.importSessions → registerSession): the transcript,
 * directory binding and busy state already live on the server, so the
 * row simply joins the sidebar's project folders — nothing is copied.
 *
 * Data arrives through the session-data context (foreignSessions is
 * live-patched by the same bus folds that feed the sidebar, so sessions
 * another client creates while the picker is open appear here). Rows
 * group by PROJECT directory exactly like the sidebar (branch-worktree
 * sessions merge into their main repo's group), leave in place through
 * ExitList as they are imported, and the whole row is the import
 * action — this is a picker, not a manager.
 */
export default function ImportSessionsModal({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const t = useI18n();
    const colors = useColors();
    // The scroll cap follows the LAYOUT (hooks/useLayoutMode.ts): the
    // fullscreen sheet of the phone layout needs no max-h, tablet
    // mode's centered panel keeps the desktop cap.
    const phoneLayout = usePhoneLayout();
    const {foreignSessions, busyIds, importSessions} = useSessionData();
    // Branch-worktree bindings feed the PROJECT grouping (a worktree
    // session joins its main repo's group), same as the sidebar.
    const worktreeDirs = useWorktreeDirs();
    // Ticking "now" for relative ages — only while the picker is open.
    const now = useNow(30_000, open);
    // Conditional edge fades for the scroll body (short lists stay
    // fade-free).
    const edges = useScrollEdges<HTMLDivElement>();

    const infos: SessionInfo[] = foreignSessions.map((s) => ({
        id: s.id,
        name: s.title?.trim() || t["Untitled"],
        directory: s.directory ?? s.location?.directory,
        updatedAt: s.time?.updated,
        // Foreign sessions carry no mode stamp — they import as dev
        // (appMode.sessionMode's default for unstamped sessions).
        mode: sessionMode(s),
    }));
    const groups = groupByDirectory(infos, worktreeDirs);

    return (
        <Modal
            open={open}
            onClose={onClose}
            width={560}
            title={
                // The title node spans the header's flex-1 slot, so the
                // Import All action sits in the title bar itself, left of
                // the close button (Modal's title is a ReactNode by
                // design — no chrome primitive change needed).
                <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold truncate leading-normal">{t["Import Session"]}</span>
                    {infos.length > 1 && (
                        <Button
                            size="sm"
                            label={t["Import All"]}
                            onClick={() => importSessions(infos.map((s) => s.id))}
                        />
                    )}
                </div>
            }
        >
            <div
                ref={edges.ref}
                onScroll={edges.onScroll}
                className={`flex-1 min-h-0 overflow-y-auto px-3 py-2 lum-fade-md ${phoneLayout ? "" : "max-h-[70vh]"} ${
                    edges.top ? "lum-fade-top " : ""
                }${edges.bottom ? "lum-fade-bottom" : ""}`}
            >
                {infos.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center">
                        <span className="text-sm" style={{color: colors.textPrimary}}>
                            {t["No sessions to import"]}
                        </span>
                        <span className="text-xs max-w-72" style={{color: colors.inactiveText}}>
                            {t["Sessions created outside Lumina Code (the TUI, CLI or another instance) appear here."]}
                        </span>
                    </div>
                ) : (
                    groups.map(([directory, groupSessions]) => (
                        <div key={directory || "other"} className="pt-2 first:pt-0.5">
                            {/* The group header mirrors the sidebar's folder
                                * header: the directory's last segment, the
                                * hint carrying the full path; sessions with
                                * no directory land in the "Other" bucket. */}
                            <Hint label={directory || undefined} className="w-full px-3 pb-1">
                                <span
                                    className="block text-left truncate text-2xs font-medium uppercase tracking-wider"
                                    style={{color: colors.inactiveText}}
                                >
                                    {directory ? folderLabel(directory) : t["Other Sessions"]}
                                </span>
                            </Hint>
                            <ExitList
                                items={groupSessions}
                                keyOf={(session) => session.id}
                                exitMs={250}
                                exit={{animation: "lum-row-exit"}}
                                rowClassName="my-0.5"
                            >
                                {(session) => {
                                    const busy = busyIds.has(session.id);
                                    return (
                                        <button
                                            type="button"
                                            className="lum-enter group relative w-full flex items-center gap-2.5 pl-8 pr-3 py-2 rounded-[var(--radius-sm)] lum-wash cursor-pointer text-left transition-colors duration-[var(--duration-fast)]"
                                            style={{"--lum-wash": colors.hoverOverlay} as CSSProperties}
                                            onClick={() => importSessions([session.id])}
                                        >
                                            {/* Busy dot pins into the indent gutter,
                                                * matching the sidebar row anatomy. */}
                                            {busy && (
                                                <span
                                                    className="absolute left-3 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full animate-pulse pointer-events-none"
                                                    style={{backgroundColor: "var(--color-brand-lavender)"}}
                                                />
                                            )}
                                            <span
                                                className="shrink-0 flex items-center transition-opacity duration-[var(--duration-fast)] opacity-60 group-hover:opacity-100"
                                                style={{color: colors.inactiveText}}
                                            >
                                                <FolderInput size={13}/>
                                            </span>
                                            <span
                                                className={`flex-1 min-w-0 truncate text-sm leading-tight ${
                                                    busy ? "font-medium" : ""
                                                }`}
                                                style={{color: busy ? colors.textPrimary : colors.inactiveText}}
                                            >
                                                {session.name}
                                            </span>
                                            {session.updatedAt != null && (
                                                <span
                                                    className="shrink-0 text-2xs tabular-nums"
                                                    style={{color: colors.inactiveText}}
                                                >
                                                    {relativeAge(session.updatedAt, now)}
                                                </span>
                                            )}
                                        </button>
                                    );
                                }}
                            </ExitList>
                        </div>
                    ))
                )}
            </div>
        </Modal>
    );
}
