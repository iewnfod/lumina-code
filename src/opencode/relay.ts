/**
 * Relay-delivery bookkeeping (the forward path's desktop side): the
 * server delivers at-least-once (an un-acked prompt re-delivers after a
 * desktop death), so the consumer DEDUPES by prompt id and bounds
 * retries — a poison prompt (its session vanished, the local server
 * rejects it) must not clog the queue forever.
 */

/** Attempts a prompt gets before it is acked-and-dropped as poison. */
export const RELAY_MAX_ATTEMPTS = 2;

export interface RelayLedger {
    /** Record a delivery attempt; returns the attempt number (1 = first
     * time this id is seen). */
    attempt(id: number): number;
    /** Forget an id (after a successful inject + ack). */
    forget(id: number): void;
}

/** Bounded id→attempts ledger, FIFO-evicted past `cap`. */
export function createRelayLedger(cap = 500): RelayLedger {
    const seen = new Map<number, number>();
    return {
        attempt(id: number): number {
            const next = (seen.get(id) ?? 0) + 1;
            seen.set(id, next);
            if (seen.size > cap) {
                // Map iteration order = insertion order: drop the oldest.
                const oldest = seen.keys().next().value;
                if (oldest !== undefined && oldest !== id) seen.delete(oldest);
            }
            return next;
        },
        forget(id: number): void {
            seen.delete(id);
        },
    };
}
