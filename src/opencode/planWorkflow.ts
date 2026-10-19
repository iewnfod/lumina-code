/**
 * The plan workflow's transcript derivations — the FRONTEND MIRROR of
 * the plugin's planStateFromEntries fold (src/plugins/luminaTools.js):
 * the last plan_submit defines the task list, subsequent completed
 * task_complete / plan_amend / work_submit parts advance it, and the
 * two Route A gates (planApprovalPending / workApprovalPending) derive
 * their pending payloads. Split from sessionActivity.ts (the stats-card
 * derivations stay there); sessionActivity re-exports everything from
 * here, so importing from either file keeps working.
 *
 * Pure: no React — node-testable.
 */
import type {AssistantToolPart, ChatMessage} from "./types.ts";
import {inputRecord, toolParts} from "./sessionActivity.ts";

/** Tool names of the plan workflow (src/plugins/luminaTools.js). The
 * names are the contract between the plugin's executors, this file's
 * derivations and the approval card's request routing. */
export const PLAN_SUBMIT_TOOL = "plan_submit";
export const TASK_COMPLETE_TOOL = "task_complete";
export const PLAN_AMEND_TOOL = "plan_amend";
export const WORK_SUBMIT_TOOL = "work_submit";

/** One task of the session's approved plan. */
export interface SessionTodoItem {
    /** Normalized title (whitespace collapsed) — the verbatim identifier
     * task_complete must echo. */
    title: string;
    status: "pending" | "completed" | "blocked";
    /** Why a blocked task is blocked. */
    reason?: string;
}

/** The session's plan-workflow state, derived from its transcript. */
export interface SessionTodos {
    /** The plan's short name (plan_submit's title input). */
    title: string;
    items: SessionTodoItem[];
    /** The defining plan_submit part is still unsettled — its approval
     * card is up (or was lost to a disconnect); the list shown is the
     * PROPOSED one. False once the agent switched to build (approval IS
     * the switch — including the restart-recovery case where the part
     * stays frozen running in storage). */
    pendingApproval: boolean;
    /** A successful work_submit followed the plan — the user ACCEPTED the
     * delivered work and the executor archived the plan. Terminal. */
    archived: boolean;
    /** A work_submit was attempted for THIS plan (any outcome — the
     * submission itself persists report.md before the gate). Gates the
     * stats panel's "view report" button: no submission, no button. */
    reportSubmitted: boolean;
}

/** The input's todos as strings (null unless it is a clean string[]). */
function todoTitles(input: Record<string, unknown>): string[] | null {
    const v = input["todos"];
    if (!Array.isArray(v)) return null;
    const out: string[] = [];
    for (const item of v) {
        if (typeof item !== "string" || !item.trim()) return null;
        out.push(item);
    }
    return out;
}

/** Normalize a task title the way the plugin's executor does — trim and
 * collapse whitespace runs; everything else (including case) is exact. */
function normalizeTodoTitle(s: string): string {
    return s.trim().replace(/\s+/g, " ");
}

/** Apply one successful task_complete input to the item list (a mismatch
 * is a server-rejected call — ignored). Mirrors the plugin's fold so
 * both sides derive identical state. */
function applyTodoEvent(items: SessionTodoItem[], input: Record<string, unknown>): void {
    const raw = input["title"];
    if (typeof raw !== "string") return;
    const title = normalizeTodoTitle(raw);
    const next = items.find((i) => i.status === "pending");
    if (!next || next.title !== title) return;
    if (input["blocked"] === true) {
        next.status = "blocked";
        const reason = input["reason"];
        if (typeof reason === "string" && reason.trim()) next.reason = reason.trim();
    } else {
        next.status = "completed";
    }
}

/** Context the transcript alone cannot provide to the gate folds —
 * everything restart recovery needs beyond part status:
 * - `agent`: the session's CURRENT agent. Approval in this architecture
 *   IS the agent switch to build (the plugin executor's poll waits for
 *   exactly that), so a plan_submit part frozen RUNNING by an app
 *   restart (the server persists parts as running at call start and
 *   never settles orphans) counts as APPROVED under "build" — mirroring
 *   planStateFromEntries in the plugin source; keep the two in sync.
 * - `decided`: locally recorded verdicts for parts whose executor died
 *   in a restart (partId → decision), which outlive the frozen running
 *   status in storage. Omitted/undefined agent ⇒ legacy status-only
 *   reading (the sidebar badge keeps it deliberately — a badge on an
 *   orphaned gate draws the user to the session). */
export interface GateContext {
    agent?: string;
    decided?: ReadonlyMap<string, GateDecision>;
}

/** A locally recorded verdict for a restart-orphaned gate part. */
export type GateDecision = "rejected" | "accepted";

/**
 * The session's plan-workflow state: the LAST plan_submit tool part
 * defines the task list (status "error" = rejected submission → no
 * active plan), and every subsequent SUCCESSFUL task_complete /
 * plan_amend part advances it. Rejected calls (mismatched titles, plan
 * amendments the executor refused) carry status "error" and never count.
 * pendingApproval marks a submission whose part hasn't settled yet — the
 * approval card is the live one; under agent "build" the switch already
 * happened, so even a frozen running submission counts as approved (see
 * GateContext). Mirrors planStateFromEntries in the plugin source; keep
 * the two in sync.
 */
export function collectSessionTodos(list: ChatMessage[], opts?: GateContext): SessionTodos | null {
    const parts = toolParts(list);
    let submitIdx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].name === PLAN_SUBMIT_TOOL) {
            submitIdx = i;
            break;
        }
    }
    if (submitIdx < 0) return null;
    const submit = parts[submitIdx];
    if (submit.state.status === "error") return null;
    // A locally recorded rejection ends the wait the same way a settled
    // part would (the frozen running status in storage outlives it).
    if (opts?.decided?.get(submit.id) === "rejected") return null;
    const input = inputRecord(submit);
    const title = input["title"];
    const planTodos = todoTitles(input);
    if (typeof title !== "string" || !title.trim() || !planTodos || planTodos.length === 0) return null;
    const items: SessionTodoItem[] = planTodos.map((raw) => ({
        title: normalizeTodoTitle(raw),
        status: "pending",
    }));
    let archived = false;
    let reportSubmitted = false;
    for (let i = submitIdx + 1; i < parts.length; i++) {
        const part = parts[i];
        // Any work_submit part (even running/errored) means a submission
        // attempt — the executor persists report.md before its gate, so
        // the document is viewable from the first call on.
        if (part.name === WORK_SUBMIT_TOOL) reportSubmitted = true;
        if (part.state.status !== "completed") {
            // Restart recovery: a work_submit frozen running whose
            // acceptance was recorded locally still counts as acceptance.
            if (part.name === WORK_SUBMIT_TOOL && opts?.decided?.get(part.id) === "accepted") {
                archived = true;
            }
            continue;
        }
        const partInput = inputRecord(part);
        if (part.name === TASK_COMPLETE_TOOL) {
            applyTodoEvent(items, partInput);
        } else if (part.name === PLAN_AMEND_TOOL) {
            const next = todoTitles(partInput);
            if (next) {
                const history = items.filter((i) => i.status !== "pending");
                items.length = 0;
                items.push(
                    ...history,
                    ...next.map((raw) => ({title: normalizeTodoTitle(raw), status: "pending" as const})),
                );
            }
        } else if (part.name === WORK_SUBMIT_TOOL) {
            // Mirror of the plugin's fold: a COMPLETED work_submit = the
            // user accepted the work; the executor archived the plan.
            archived = true;
        }
    }
    return {
        title: title.trim(),
        items,
        pendingApproval:
            (submit.state.status === "running" || submit.state.status === "pending") && opts?.agent !== "build",
        archived,
        reportSubmitted,
    };
}

/** A validated plan_submit payload — what the approval card renders. */
export interface PlanSubmitPayload {
    /** The submitting tool part's id — restart-recovery verdicts are
     * recorded against it (gateDecisions.ts). */
    partId: string;
    title: string;
    plan: string;
    todos: string[];
}

function parsePlanSubmitPayload(part: AssistantToolPart): PlanSubmitPayload | null {
    const input = inputRecord(part);
    const title = input["title"];
    const plan = input["plan"];
    const todos = todoTitles(input);
    if (
        typeof title !== "string" ||
        !title.trim() ||
        typeof plan !== "string" ||
        !plan.trim() ||
        !todos ||
        todos.length === 0
    ) {
        return null;
    }
    return {partId: part.id, title: title.trim(), plan, todos};
}

/**
 * Locate the plan_submit payload a pending permission request refers to:
 * by its tool source (messageID + part id — permission requests carry
 * `source` when a tool call triggered them), falling back to the LAST
 * plan_submit part in the transcript. Null when nothing parseable is
 * found — the caller falls back to the generic permission card.
 */
export function findPlanSubmitInput(
    list: ChatMessage[],
    source?: {messageID?: string; id?: string} | null,
): PlanSubmitPayload | null {
    const parts = toolParts(list);
    if (source?.id) {
        for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i].id === source.id) {
                // Located the request's own part: its payload is the
                // answer, even when malformed (never substitute another
                // plan under a request about this one).
                return parsePlanSubmitPayload(parts[i]);
            }
        }
    }
    for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].name === PLAN_SUBMIT_TOOL) return parsePlanSubmitPayload(parts[i]);
    }
    return null;
}

/**
 * The pending plan approval (Route A): the payload of the LAST
 * plan_submit part while it is still unsettled — the plugin's executor
 * BLOCKS inside the call until the user decides, so a running part IS a
 * pending decision. Null once the part settles (approval completed it;
 * rejection/timeout errored it) and when no submission exists.
 * Restart recovery (GateContext): a part frozen running under agent
 * "build" was approved (the switch IS the approval; the executor merely
 * died before settling the part) and a locally recorded rejection ends
 * the wait — both read as "no pending decision".
 */
export function planApprovalPending(list: ChatMessage[], opts?: GateContext): PlanSubmitPayload | null {
    const part = lastUnsettledPart(list, PLAN_SUBMIT_TOOL);
    if (!part) return null;
    if (opts?.agent === "build") return null;
    if (opts?.decided?.get(part.id) === "rejected") return null;
    return parsePlanSubmitPayload(part);
}

/** A validated work_submit payload — what the acceptance card renders. */
export interface WorkSubmitPayload {
    /** The submitting tool part's id — restart-recovery verdicts are
     * recorded against it (gateDecisions.ts). */
    partId: string;
    report: string;
}

function parseWorkSubmitPayload(part: AssistantToolPart): WorkSubmitPayload | null {
    const report = inputRecord(part)["report"];
    if (typeof report !== "string" || !report.trim()) return null;
    return {partId: part.id, report};
}

/**
 * The pending work ACCEPTANCE (the workflow's second gate, Route A twin
 * of planApprovalPending): the payload of the LAST work_submit part
 * while it is still unsettled — its executor blocks until the user has
 * tested the work (acceptance archives the plan; rejection returns it
 * for fixes). Null once the part settles and when no submission exists.
 * Restart recovery (GateContext): a locally recorded verdict (accept or
 * reject) ends the wait — the frozen running status in storage outlives
 * the decision.
 */
export function workApprovalPending(list: ChatMessage[], opts?: GateContext): WorkSubmitPayload | null {
    const part = lastUnsettledPart(list, WORK_SUBMIT_TOOL);
    if (!part) return null;
    const decision = opts?.decided?.get(part.id);
    if (decision === "accepted" || decision === "rejected") return null;
    return parseWorkSubmitPayload(part);
}

/** The LAST part of the given gate tool while still unsettled — Route
 *  A's shared "is a gate waiting?" scan (planApprovalPending and
 *  workApprovalPending are this plus their own restart-recovery
 *  verdicts). Null when the part settles, when no submission exists,
 *  or when the newest submission already settled. */
function lastUnsettledPart(list: ChatMessage[], tool: string): AssistantToolPart | null {
    const parts = toolParts(list);
    for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i];
        if (part.name !== tool) continue;
        if (part.state.status !== "running" && part.state.status !== "pending") return null;
        return part;
    }
    return null;
}
