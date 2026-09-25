import {createContext, useContext, useMemo, type ReactNode} from "react";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeStatus, OpencodeEventHandler} from "./useOpencode.ts";

/**
 * The connection context — the app's ONE distribution point for the
 * OpenCode server handles (`api` + `subscribe`, owned by App's
 * useOpencode) and its lifecycle status.
 *
 * This is the base layer of the three-context split (connection /
 * catalog / session data): components that need a raw handle for a
 * self-contained concern (settings' credential flows, the composer's
 * file/command lookups, the terminal drill's output polling) read it
 * here instead of threading `api`/`subscribe` props through every
 * level. Domain data does NOT live here — see catalogContext.tsx and
 * sessionDataContext.tsx, whose providers consume this one.
 */

interface ConnectionContextValue {
    api: OpencodeApi | null;
    subscribe: (handler: OpencodeEventHandler) => () => void;
    status: OpencodeStatus;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({
    api,
    subscribe,
    status,
    children,
}: ConnectionContextValue & {children: ReactNode}) {
    const value = useMemo(() => ({api, subscribe, status}), [api, subscribe, status]);
    return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

/** The server handles + connection status. `api` is null while
 *  disconnected — every consumer already handles that shape (it was the
 *  prop signature before). */
export function useConnection(): ConnectionContextValue {
    const ctx = useContext(ConnectionContext);
    if (!ctx) throw new Error("useConnection requires ConnectionProvider");
    return ctx;
}
