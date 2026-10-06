import {useMemo, useState} from "react";
import {Activity as ActivityIcon, ChevronDown} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import type {ChatMessage} from "../../opencode/types.ts";
import {deriveActivity, isActivityEmpty} from "../activity.ts";
import {patchHunks} from "../../components/chat/toolDiff.ts";
import DiffViewBody from "../../components/chat/DiffViewBody.tsx";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import {displayPath} from "../../lib/path.ts";

/** One mirrored working-copy diff entry (the server's DiffPushEntry). */
export interface MirroredDiffEntry {
    file: string;
    patch: string;
    additions: number;
    deletions: number;
    status: string;
}

/**
 * The mobile WORKSPACE ACTIVITY panel: the transcript-derived state of
 * the session's surroundings — plan todos with live statuses, background
 * terminals, subagents — plus the MIRRORED working-copy diff (file rows
 * expanding into the shared DiffViewBody). Collapsed by default under
 * the session header; the folds run in the same render as the transcript
 * (they are pure and memoized on the snapshot).
 */
export default function ActivityPanel({
    messages,
    diff,
}: {
    messages: ChatMessage[];
    /** The directory's mirrored working-copy diff (null = not loaded). */
    diff: MirroredDiffEntry[] | null;
}) {
    const t = useI18n();
    const colors = useColors();
    const [open, setOpen] = useState(false);
    const [openFile, setOpenFile] = useState<string | null>(null);

    const activity = useMemo(() => deriveActivity(messages), [messages]);
    const hasDiff = diff != null && diff.length > 0;
    const empty = isActivityEmpty(activity) && !hasDiff;
    if (empty) return null;

    const diffTotals = useMemo(() => {
        let added = 0;
        let removed = 0;
        for (const entry of diff ?? []) {
            added += entry.additions;
            removed += entry.deletions;
        }
        return {added, removed, files: diff?.length ?? 0};
    }, [diff]);

    const summary = hasDiff
        ? `${t["Changes"]} ${diffTotals.files} · +${diffTotals.added} −${diffTotals.removed}`
        : activity.todos != null
          ? `${t["Todo"]} ${activity.todos.items.filter((i) => i.status === "completed").length}/${activity.todos.items.length}`
          : [
                activity.shells.length > 0 ? `${activity.shells.length} ${t["Terminals"]}` : null,
                activity.subagents.length > 0
                    ? `${activity.subagents.length} ${t["Subagents"]}`
                    : null,
                activity.fileEdits > 0 ? `${activity.fileEdits} ${t["Changes"]}` : null,
            ]
              .filter(Boolean)
              .join(" · ");

    return (
        <div
            className="lum-m-activity"
            style={{background: colors.recessedBg, borderColor: colors.glassBorder}}
        >
            <button
                type="button"
                className="lum-m-activity-header"
                onClick={() => setOpen(!open)}
            >
                <ActivityIcon size={14}/>
                <span className="lum-m-activity-summary">{summary}</span>
                <ChevronDown
                    size={14}
                    style={{transform: open ? "rotate(180deg)" : "none", transition: "transform .15s"}}
                />
            </button>
            {open && (
                <div className="lum-m-activity-body">
                    {activity.todos != null && (
                        <section>
                            <h4>{activity.todos.title}</h4>
                            <ul>
                                {activity.todos.items.map((item) => (
                                    <li
                                        key={item.title}
                                        className={`lum-m-todo ${item.status}`}
                                    >
                                        <span className="lum-m-todo-glyph">
                                            {item.status === "completed"
                                                ? "✓"
                                                : item.status === "blocked"
                                                  ? "⏸"
                                                  : "○"}
                                        </span>
                                        <span>{item.title}</span>
                                        {item.status === "blocked" && item.reason && (
                                            <em className="lum-m-todo-reason">{item.reason}</em>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                    {hasDiff && (
                        <section>
                            <h4>{t["Changes"]}</h4>
                            <ul className="lum-m-diffs">
                                {diff.map((entry) => (
                                    <li key={entry.file}>
                                        <button
                                            type="button"
                                            className="lum-m-diff-row"
                                            onClick={() =>
                                                setOpenFile(openFile === entry.file ? null : entry.file)
                                            }
                                        >
                                            <img
                                                src={fileIconUrl(entry.file)}
                                                alt=""
                                                width={14}
                                                height={14}
                                            />
                                            <span className="lum-m-mono lum-m-ellipsis">
                                                {displayPath(entry.file)}
                                            </span>
                                            <span className="lum-m-dim">+{entry.additions} −{entry.deletions}</span>
                                        </button>
                                        {openFile === entry.file && entry.patch !== "" && (
                                            <div className="lum-m-diff-body">
                                                <DiffViewBody
                                                    hunks={patchHunks(entry.patch)}
                                                    fileName={entry.file}
                                                />
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                    {activity.shells.length > 0 && (
                        <section>
                            <h4>{t["Terminals"]}</h4>
                            <ul>
                                {activity.shells.map((s) => (
                                    <li key={s.id} className="lum-m-mono">
                                        {s.command}
                                        <span className="lum-m-dim">
                                            {s.finished
                                                ? ` · ${s.state ?? "completed"}${s.exit != null ? ` (${s.exit})` : ""}`
                                                : " · …"}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                    {activity.subagents.length > 0 && (
                        <section>
                            <h4>{t["Subagents"]}</h4>
                            <ul>
                                {activity.subagents.map((s, i) => (
                                    <li key={s.id ?? i}>
                                        <span className="lum-m-mono">{s.agent ?? "agent"}</span>
                                        {s.label && <span className="lum-m-dim"> · {s.label}</span>}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                </div>
            )}
        </div>
    );
}
