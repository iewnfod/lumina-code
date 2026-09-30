import {memo, useCallback, useEffect, useRef, useState} from "react";
import {ArrowRight, Circle, CircleAlert, CircleCheck, ClipboardCheck, FileText, ListChecks} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {findSessionArchive, findSessionTaskDir, readTaskDocument, stripPlanAnchor} from "../../opencode/planDocuments.ts";
import type {SessionTodoItem, SessionTodos} from "../../opencode/sessionActivity.ts";
import {FinishedTotal, StateChip, StatsSection} from "./statsChrome.tsx";
import Modal from "../ui/Modal.tsx";
import Markdown from "../chat/Markdown.tsx";

/** One task row's status icon. "in progress" is DERIVED — the first
 * pending task while the session executes (no task_begin tool to call
 * or forget): only it displays at full strength (accent + pulse); the
 * settled states stay quiet. The rows carry NO hover tooltip — the text
 * is the row itself (AGENTS.md §3.2: native title tooltips are banned). */
function TodoGlyph({status}: {status: SessionTodoItem["status"] | "in_progress"}) {
    if (status === "in_progress") {
        return <ArrowRight size={12} className="shrink-0 animate-pulse"/>;
    }
    if (status === "completed") {
        return <CircleCheck size={12} className="shrink-0" style={{color: "var(--color-success)"}}/>;
    }
    if (status === "blocked") {
        return <CircleAlert size={12} className="shrink-0" style={{color: "var(--color-warning)"}}/>;
    }
    return <Circle size={12} className="shrink-0 opacity-40"/>;
}

/** A quiet header icon button — the RunFooter-style hover-fade affordance
 * (IconButton's 32px chrome is too heavy for the 11px section header). */
function HeaderDocButton({label, onClick, children}: {label: string; onClick: () => void; children: React.ReactNode}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="shrink-0 inline-flex items-center justify-center rounded-[var(--radius-sm)] opacity-40 hover:opacity-90 transition-opacity cursor-pointer px-1 py-0.5 lum-wash"
            aria-label={label}
        >
            {children}
        </button>
    );
}

/** Which document the modal is showing, plus its load state. */
type DocView =
    | {kind: "plan" | "report"; token: number; state: "loading"}
    | {kind: "plan" | "report"; token: number; state: "ready"; content: string | null};

/**
 * The plan-workflow section of the stats panel: the approved plan's task
 * list with live statuses — the user's fastest read on where the AI is
 * ("done what, doing what, what's left"), no thinking-scrolling needed.
 * Sits ABOVE the changes section by design: the plan frames the work,
 * the diff is its residue. Rows are static (statuses swap in place —
 * no row ever unmounts, so no presence animation is needed).
 *
 * The header also carries VIEW buttons for the on-disk documents the
 * plugin maintains (.lumina/tasks/&lt;dir&gt;/plan.md + report.md —
 * resolved by the same session-anchor contract the plugin writes; see
 * opencode/planDocuments.ts). After acceptance the task directory is
 * gone, and the probe falls back to the session's archive ZIP — entries
 * read straight out of the stored bytes (lib/zipReader.ts), so the
 * buttons keep working for accepted plans. Reading is on demand (click).
 */
export const TodoSection = memo(function TodoSection({
    todos,
    busy,
    sessionId,
    directory,
}: {
    todos: SessionTodos;
    /** The session is executing — derives the in-progress task. */
    busy: boolean;
    /** For the document view buttons' directory resolution. */
    sessionId: string;
    /** The session's working directory (null = server default). */
    directory: string | null;
}) {
    const t = useI18n();
    const {api} = useConnection();
    const firstPending = todos.items.findIndex((i) => i.status === "pending");
    const inProgress = !todos.pendingApproval && busy && firstPending >= 0;
    const completed = todos.items.filter((i) => i.status === "completed").length;
    const allDone = !todos.pendingApproval && todos.items.length > 0 && completed === todos.items.length;

    const [view, setView] = useState<DocView | null>(null);
    // Stale-response guard: only the newest open survives (rapid clicks,
    // a close mid-fetch).
    const tokenRef = useRef(0);

    const openDoc = useCallback(
        (kind: "plan" | "report") => {
            if (!api || !directory) return;
            const token = ++tokenRef.current;
            setView({kind, token, state: "loading"});
            void (async () => {
                let content: string | null = null;
                try {
                    // Live task directory first; after acceptance that is
                    // gone and the documents live inside the archive zip —
                    // the session-anchored probe reads them straight out of
                    // the stored entries (lib/zipReader.ts).
                    const dirName = await findSessionTaskDir(api, directory, sessionId, todos.title);
                    if (dirName) {
                        content = await readTaskDocument(api, directory, dirName, kind === "plan" ? "plan.md" : "report.md");
                    } else {
                        const archive = await findSessionArchive(api, directory, sessionId, todos.title);
                        if (archive) content = archive.read(kind === "plan" ? "plan.md" : "report.md");
                    }
                } catch {
                    content = null; // read failures read as "absent"
                }
                if (tokenRef.current !== token) return;
                setView({kind, token, state: "ready", content});
            })();
        },
        [api, directory, sessionId, todos.title],
    );

    // A plan switch (todos.title change) must not leave a stale modal open
    // against another plan's title.
    useEffect(() => {
        tokenRef.current++;
        setView(null);
    }, [todos.title, sessionId]);

    return (
        <StatsSection
            icon={<ListChecks size={13}/>}
            title={t["Plan progress"]}
            actions={
                directory && api ? (
                    // Tighter than the header's gap-2: the two buttons'
                    // own px-1 paddings already add 8px of visual space
                    // between their icons, so gap-1 keeps their spacing
                    // level with the button→chip gap to the right.
                    <span className="inline-flex items-center gap-1">
                        <HeaderDocButton label={t["View plan"]} onClick={() => openDoc("plan")}>
                            <FileText size={12}/>
                        </HeaderDocButton>
                        {/* Only once a work_submit exists — the report file
                         * rides the submission itself (no submission, no
                         * file, no button). */}
                        {todos.reportSubmitted && (
                            <HeaderDocButton label={t["View report"]} onClick={() => openDoc("report")}>
                                <ClipboardCheck size={12}/>
                            </HeaderDocButton>
                        )}
                    </span>
                ) : undefined
            }
            summary={
                todos.pendingApproval ? (
                    <StateChip running label={t["Waiting for approval"]}/>
                ) : todos.archived ? (
                    // Acceptance is terminal: the user tested the work and
                    // the plan's record lives in .lumina/archived/ now.
                    <StateChip running={false} label={t["Archived"]}/>
                ) : allDone ? (
                    // Every task settled but the work is NOT accepted yet —
                    // archival waits for the user's testing (work_submit's
                    // gate); this chip is that standing invitation.
                    <StateChip running label={t["Awaiting review"]}/>
                ) : (
                    <span className="shrink-0 text-2xs opacity-50">
                        <FinishedTotal finished={completed} total={todos.items.length}/>
                    </span>
                )
            }
        >
            {todos.items.map((item, i) => (
                <div
                    key={`${i}-${item.title}`}
                    // First row breathes below the section header (its
                    // py-1 alone reads as glued to the title).
                    className={`w-full flex items-center gap-2 px-2 py-1 text-xs rounded-[var(--radius-sm)] ${i === 0 ? "pt-2" : ""}`}
                >
                    <TodoGlyph
                        status={inProgress && i === firstPending ? "in_progress" : item.status}
                    />
                    {/* truncate's clip box is the line box — at text-xs
                     * (1.33 line-height) the app's font metrics overshoot
                     * it and descenders (g/y/p) lose their bottom half.
                     * leading-[1.5] grows the box SYMMETRICALLY (half-
                     * leading above and below), so the text stays centered
                     * against the row's icon — padding would shift it. */}
                    <span
                        className={`min-w-0 truncate text-left leading-[1.5] ${
                            item.status === "completed" ? "opacity-45 line-through" : "opacity-85"
                        }`}
                    >
                        {item.title}
                    </span>
                    {item.status === "blocked" && item.reason && (
                        <span className="ml-auto shrink-0 max-w-[45%] truncate leading-[1.5] opacity-50">{item.reason}</span>
                    )}
                </div>
            ))}
            {view && (
                <Modal
                    open
                    onClose={() => {
                        tokenRef.current++;
                        setView(null);
                    }}
                    title={view.kind === "plan" ? todos.title : t["Work report"]}
                    width={640}
                >
                    {view.state === "loading" ? (
                        <div className="flex items-center justify-center py-10 text-xs opacity-50">…</div>
                    ) : view.content == null ? (
                        <div className="px-5 py-8 text-xs opacity-55">
                            {view.kind === "plan" ? t["Plan file not found"] : t["No report yet"]}
                        </div>
                    ) : (
                        <div className="px-5 pt-4 pb-5 overflow-y-auto max-h-[70vh] lum-md lum-fade-top lum-fade-bottom lum-fade-lg">
                            <Markdown>{stripPlanAnchor(view.content)}</Markdown>
                        </div>
                    )}
                </Modal>
            )}
        </StatsSection>
    );
});
