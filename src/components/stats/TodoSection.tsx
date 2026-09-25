import {memo} from "react";
import {ArrowRight, Circle, CircleAlert, CircleCheck, ListChecks} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import type {SessionTodoItem, SessionTodos} from "../../opencode/sessionActivity.ts";
import {FinishedTotal, StateChip, StatsSection} from "./statsChrome.tsx";

/** One task row's status icon. "in progress" is DERIVED — the first
 * pending task while the session executes (no task_begin tool to call
 * or forget): only it displays at full strength (accent + pulse); the
 * settled states stay quiet. The row's own title attribute carries the
 * tooltip (task text / blocked reason), so the icons stay bare. */
function TodoGlyph({status}: {status: SessionTodoItem["status"] | "in_progress"}) {
    if (status === "in_progress") {
        return <ArrowRight size={12} className="shrink-0 animate-pulse"/>;
    }
    if (status === "completed") {
        return <CircleCheck size={12} className="shrink-0" style={{color: "#10b981"}}/>;
    }
    if (status === "blocked") {
        return <CircleAlert size={12} className="shrink-0" style={{color: "#f59e0b"}}/>;
    }
    return <Circle size={12} className="shrink-0 opacity-40"/>;
}

/**
 * The plan-workflow section of the stats panel: the approved plan's task
 * list with live statuses — the user's fastest read on where the AI is
 * ("done what, doing what, what's left"), no thinking-scrolling needed.
 * Sits ABOVE the changes section by design: the plan frames the work,
 * the diff is its residue. Rows are static (statuses swap in place —
 * no row ever unmounts, so no presence animation is needed).
 */
export const TodoSection = memo(function TodoSection({
    todos,
    busy,
}: {
    todos: SessionTodos;
    /** The session is executing — derives the in-progress task. */
    busy: boolean;
}) {
    const t = useI18n();
    const firstPending = todos.items.findIndex((i) => i.status === "pending");
    const inProgress = !todos.pendingApproval && busy && firstPending >= 0;
    const completed = todos.items.filter((i) => i.status === "completed").length;
    return (
        <StatsSection
            icon={<ListChecks size={13}/>}
            title={t["Plan progress"]}
            summary={
                todos.pendingApproval ? (
                    <StateChip running label={t["Waiting for approval"]}/>
                ) : (
                    <span className="shrink-0 text-[10px] opacity-50">
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
                    title={item.status === "blocked" && item.reason ? item.reason : item.title}
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
        </StatsSection>
    );
});
