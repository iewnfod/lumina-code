import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api/index.ts";
import {markSweepCancels} from "./promptQueue.ts";
import {clearSessionStopping, isSessionStopping, markSessionStopping} from "./sessionStopping.ts";

/**
 * The STOP discipline, module-level so BOTH callers share it: the
 * transcript's stop button (the useSessionMessages hook) and the
 * interruptSession keyboard shortcut (AppBody, which mounts no
 * transcript hook of its own). Everything the stop implies on v2.0.11 —
 * the immediate stopping marker, the idempotent in-flight fence, the
 * persisted-inbox SWEEP that makes "stop" final — lives here; see the
 * inline comments for the server-behavior receipts.
 */

/** The stopping fence shared by every send-shaped action: true while this
 *  session's stop is unwinding — the caller drops the action (stop means
 *  stop; a POST landing in the window would be swept or RESTART the run
 *  as a successor execution, v2.0.11 — see send's full note). */
export function stopInFlight(sid: string, what: string): boolean {
    if (!isSessionStopping(sid)) return false;
    logInfo(`${what} suppressed: session stop is in flight`).catch(() => {});
    return true;
}

export async function interruptSessionRun(api: OpencodeApi, sessionId: string): Promise<void> {
    const wasStopping = isSessionStopping(sessionId);
    // The stopping marker goes up the MOMENT the button is pressed:
    // the server takes a moment to actually unwind the run, and the
    // tail's indicator must say "Stopping" through that window (see
    // sessionStopping.ts). The bus fold settles it when the run-end
    // event arrives; the branches below only cover the cases where
    // no such event will come — a false response means nothing was
    // running, a throw means the request itself failed. A true
    // response does nothing: the end event may already have cleared
    // the marker (either order is safe — clearing is idempotent and
    // never resurrected here).
    markSessionStopping(sessionId);
    // Idempotent stop: a marker already up means an interrupt POST is
    // in flight and owns the abort — a second POST here would return
    // false (the coordinator reports stopping-already as idle) and
    // prematurely drop the marker, re-opening the send fence inside
    // the stop window. Callers that stack actions during one stop
    // ("stop and send" expediting several rows) rely on this.
    if (wasStopping) return;
    let interrupted = false;
    let failed = false;
    try {
        interrupted = await api.interruptSession(sessionId);
    } catch (e) {
        failed = true;
        logError(`Failed to interrupt session: ${e}`).catch(() => {});
    }
    // SWEEP the server inbox (v2.0.11, source-verified): the interrupt
    // only kills the in-flight execution — prompts POSTed mid-run (a
    // raw steer; this client no longer produces them — "stop and
    // send" expedites + interrupts instead — but a racing client or
    // an in-flight POST can) sit in the PERSISTED inbox as pending
    // steer rows that no step boundary has promoted yet, and they
    // survive the
    // stop: a prompt POST landing after the interrupt restarts the run
    // as a successor execution, and anything left parked resurrects
    // inside the NEXT turn's first promotion. Cancelling every pending
    // row makes "stop" final server-side. Runs on every interrupt
    // outcome (the parked rows are there whatever the POST said) and
    // is best-effort: a failed sweep logs and leaves the rows for the
    // next stop to retry.
    try {
        const pending = await api.listSessionInbox(sessionId);
        // Declare the cancels to the "stop and send" snapshot BEFORE
        // the DELETE loop: this sweep is exactly what the expedited
        // batch is waiting to survive (its rows re-POST once the run
        // settles), and without the declaration the `cancelled` frames
        // this loop triggers would prune the snapshot empty — the
        // batch then delivered nothing and the prompts vanished (the
        // ⚡ button's own stop ate its send). No-op without a snapshot.
        if (pending.length > 0) markSweepCancels(sessionId, pending.map((r) => r.id));
        for (const row of pending) {
            await api.cancelSessionInbox(sessionId, row.id);
        }
        if (pending.length > 0) {
            logInfo(`Interrupt swept ${pending.length} pending inbox input(s)`).catch(() => {});
        }
    } catch (e) {
        logWarn(`Failed to sweep session inbox after interrupt: ${e}`).catch(() => {});
    }
    if (failed || !interrupted) clearSessionStopping(sessionId);
}
