import {useSyncExternalStore} from "react";

/**
 * The frp direct route's LIVE connection status (Settings → Server): the
 * remote-access engine (hooks/useServerFrp.ts) writes its phase
 * transitions here, the Server pane reads them. Module store +
 * useSyncExternalStore binding (the sessionStopping pattern), deliberately
 * NOT persisted — status is ephemeral, unlike the credential store it
 * complements (serverConnection.ts).
 *
 * States:
 * - "off"          remote access disabled (the default)
 * - "starting"     registering with the server / starting frpc — also
 *                  while waiting for the local opencode handle
 * - "running"      frpc alive, the route is live
 * - "retrying"     a start attempt failed; the retry timer is scheduled
 * - "unavailable"  the server has no frps configured (operator-side gap,
 *                  no retry)
 * - "exited"       the frpc process died unexpectedly; the engine is
 *                  reconnecting
 * - "error"        engine-side permanent failure (could not derive the
 *                  local opencode password/port — deterministic until the
 *                  local handle changes, retrying is pointless)
 */

export type FrpStatusState =
    | "off"
    | "starting"
    | "running"
    | "retrying"
    | "unavailable"
    | "exited"
    | "error";

export interface FrpStatus {
    state: FrpStatusState;
    /** Optional diagnostic detail (error text / exit reason). */
    detail?: string;
}

let status: FrpStatus = {state: "off"};
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

/** Record a phase transition (the engine is the only writer). An absent
 * detail CLEARS a previous one — states are self-contained. */
export function setFrpStatus(state: FrpStatusState, detail?: string): void {
    if (status.state === state && status.detail === detail) return;
    status = detail === undefined ? {state} : {state, detail};
    emit();
}

/** Snapshot read (the object identity is stable between transitions). */
export function getFrpStatus(): FrpStatus {
    return status;
}

function subscribeFrpStatus(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The live frp route status (reactive). */
export function useFrpStatus(): FrpStatus {
    return useSyncExternalStore(subscribeFrpStatus, getFrpStatus, getFrpStatus);
}
