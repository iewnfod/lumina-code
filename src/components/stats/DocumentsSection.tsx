import {memo} from "react";
import {FileText, FolderOpen} from "lucide-react";
import {openPath, revealItemInDir} from "@tauri-apps/plugin-opener";
import {warn} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {displayPath} from "../../lib/path.ts";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import {isImagePath} from "../chat/attachmentPreview.ts";
import {isOfficeDocument} from "../../opencode/docstruct.ts";
import {humanSize, type DocRow} from "../../opencode/workspaceDocuments.ts";
import {MONO_STYLE} from "../chat/RequestCardChrome.tsx";
import IconButton from "../ui/IconButton.tsx";
import {ExitList} from "../ui/ExitPresence.tsx";
import {statsRowClass, StatsSection} from "./statsChrome.tsx";

/**
 * The DAILY side of the workspace panel (opencode/appMode.ts): the
 * workspace's DOCUMENT inventory with its rolling change chips — what
 * ChangesSection is for a git repo, for a folder where line counts are
 * meaningless. Clicking an OFFICE row DRILLS the panel into its preview
 * (DocumentPreviewBody — the office-tools sidecar rendered back; the
 * same overview→detail model as the file/terminal/subagent rows);
 * an IMAGE row drills too (its own pixels render — no sidecar
 * involved); every other file still opens in the system's default
 * application.
 * The row-end button reveals it in the file manager. Rows unfurl in as
 * they are born (ExitList `enter`) and the 新增/变更 chips settle back
 * to a plain inventory on the next scan.
 */
export const DocumentsSection = memo(function DocumentsSection({
    rows,
    loading,
    directory,
    onOpenDocument,
}: {
    /** The scan's rows (null before the first successful scan). */
    rows: DocRow[] | null;
    loading: boolean;
    /** The workspace directory — displayPath renders files relative
     *  to it. */
    directory: string | null;
    /** Drill into an office document's preview (the panel's own
     *  navigation — setView {kind: "document"}). */
    onOpenDocument: (row: DocRow) => void;
}) {
    const t = useI18n();
    const colors = useColors();
    const changed = rows?.filter((r) => r.change !== null).length ?? 0;
    const count = rows?.length ?? 0;

    return (
        <StatsSection
            icon={<FileText size={13}/>}
            title={t["Workspace Documents"]}
            summary={
                <span className="shrink-0 text-2xs opacity-50 tabular-nums select-none" style={MONO_STYLE}>
                    {changed > 0 ? `${changed} ${t["Updated"]}` : count > 0 ? `${count} ${t["Files"]}` : null}
                </span>
            }
        >
            <div className="flex flex-col gap-1">
                {rows === null && loading && (
                    <div className="px-2 py-1 text-xs opacity-40 select-none">{t["Loading..."]}</div>
                )}
                {rows !== null && count === 0 && (
                    // The workspace exists but holds nothing yet — say so
                    // explicitly rather than vanishing (same stance as
                    // ChangesSection's "No changes yet").
                    <div className="px-2 py-1 text-xs opacity-40 select-none">{t["No documents yet"]}</div>
                )}
                {rows !== null && count > 0 && (
                    // Same list choreography as the changes rows: a
                    // document born this scan unfurls in, a deleted one
                    // collapses away, mere re-counts render instantly.
                    <ExitList
                        items={rows}
                        keyOf={(row) => row.path}
                        enter
                        exitMs={250}
                        exit={{animation: "lum-row-exit"}}
                    >
                        {(row) => (
                            <div
                                className={statsRowClass}
                                // Office files drill into the panel's
                                // sidecar preview, images into a pixel
                                // preview (same drill view); everything
                                // else opens in the system's default
                                // application (a div, not a button: the
                                // row-end reveal is a nested button,
                                // illegal inside a button).
                                onClick={() => {
                                    if (isOfficeDocument(row.path) || isImagePath(row.path)) {
                                        onOpenDocument(row);
                                        return;
                                    }
                                    openPath(row.path).catch((e) => {
                                        warn(`Failed to open ${row.path}: ${e}`).catch(() => {});
                                    });
                                }}
                            >
                                <span className="flex items-center gap-2 min-w-0 flex-1">
                                    <img src={fileIconUrl(row.path)} alt="" className="w-4 h-4 shrink-0"/>
                                    {/* leading-[1.5]: descender clip room for
                                     * truncate — FileTitle's note. */}
                                    <span className="min-w-0 truncate text-left leading-[1.5]" style={MONO_STYLE}>
                                        {displayPath(row.path, directory)}
                                    </span>
                                </span>
                                {row.change !== null && (
                                    <span
                                        className="shrink-0 text-2xs px-1.5 py-0.5 rounded-[var(--radius-xs)] select-none"
                                        style={{
                                            background: colors.accentOverlay,
                                            color: row.change === "new"
                                                ? "var(--color-diff-add)"
                                                : "var(--color-warning)",
                                            fontWeight: 500,
                                        }}
                                    >
                                        {row.change === "new" ? t["New"] : t["Changed"]}
                                    </span>
                                )}
                                <span className="shrink-0 text-2xs opacity-45 tabular-nums select-none" style={MONO_STYLE}>
                                    {humanSize(row.size)}
                                </span>
                                <IconButton
                                    size={20}
                                    circle
                                    hoverOverlay={colors.hoverOverlay}
                                    activeOverlay={colors.activeOverlay}
                                    aria-label={t["Show in folder"]}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        revealItemInDir(row.path).catch((err) => {
                                            warn(`Failed to reveal ${row.path}: ${err}`).catch(() => {});
                                        });
                                    }}
                                >
                                    <FolderOpen size={11}/>
                                </IconButton>
                            </div>
                        )}
                    </ExitList>
                )}
            </div>
        </StatsSection>
    );
});
