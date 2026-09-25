import {createContext, useContext, useMemo, type ReactNode} from "react";
import type {OpencodeAgent, OpencodeModel} from "./types.ts";
import {useConnection} from "./connectionContext.tsx";
import {useModelCatalog} from "./useModelCatalog.ts";

/**
 * The catalog context — providers/agents/models plus the server
 * default, i.e. the SETTINGS-domain half of the three-context split
 * (connection / catalog / session data). Deliberately separate from
 * session data: the catalog changes on credential/config events, not
 * with the session list, and mixing the two would re-render the whole
 * conversation tree on every `session.updated` patch.
 *
 * Hosts useModelCatalog ONCE (it needs the connection handles, read
 * from ConnectionProvider). Consumers: the composer's model picker,
 * ChatView (image-capability checks for the vision divert), and
 * useSessionFlow's effective-model fallback.
 */

interface CatalogContextValue {
    agents: OpencodeAgent[];
    models: OpencodeModel[];
    defaultModel: OpencodeModel | null;
    /** No authenticated provider of the user's own — the model picker
     *  shows its "nothing configured" entry above the free catalog. */
    catalogOnly: boolean;
}

const CatalogContext = createContext<CatalogContextValue | null>(null);

export function CatalogProvider({children}: {children: ReactNode}) {
    const {api, subscribe} = useConnection();
    const {models, agents, defaultModel, catalogOnly} = useModelCatalog(api, subscribe);
    const value = useMemo(
        () => ({agents, models, defaultModel, catalogOnly}),
        [agents, models, defaultModel, catalogOnly],
    );
    return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogContextValue {
    const ctx = useContext(CatalogContext);
    if (!ctx) throw new Error("useCatalog requires CatalogProvider");
    return ctx;
}
