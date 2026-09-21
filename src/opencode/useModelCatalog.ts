import {useEffect, useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeAgent, OpencodeModel} from "./types.ts";

/**
 * A provider whose models come from the free public catalog (OpenCode Zen)
 * rather than the user's own credentials — detected by the baked-in public
 * API key. Those models are hidden unless they're all the user has.
 */
function isCatalogProvider(settings?: {apiKey?: string}): boolean {
    return settings?.apiKey === "public";
}

/**
 * The composer's model/agent catalog: fetched once per server connection
 * (`GET /api/model` + `/api/agent` + `/api/provider`), along with the
 * server's default model so a fresh session preselects something sensible.
 *
 * Model list hygiene: the server merges the user's authenticated providers
 * with the free OpenCode Zen catalog (and can carry near-duplicate family
 * entries), so we keep the authenticated providers' models, dedupe by
 * (provider, model), and fall back to everything only when the user has no
 * authenticated provider at all.
 */
export function useModelCatalog(api: OpencodeApi | null): {
    models: OpencodeModel[];
    /** User-selectable modes: primary, non-hidden agents (build/plan/…). */
    agents: OpencodeAgent[];
    defaultModel: OpencodeModel | null;
} {
    const [models, setModels] = useState<OpencodeModel[]>([]);
    const [agents, setAgents] = useState<OpencodeAgent[]>([]);
    const [defaultModel, setDefaultModel] = useState<OpencodeModel | null>(null);

    useEffect(() => {
        if (!api) return;
        let cancelled = false;

        api.listProviders().then((providers) => {
            if (cancelled) return;
            const catalogOnly = (providers ?? []).every((p) => isCatalogProvider(p.settings));
            const catalogIds = new Set(
                (providers ?? []).filter((p) => isCatalogProvider(p.settings)).map((p) => p.id),
            );
            return api.listModels().then((list) => {
                if (cancelled) return;
                const usable = (list ?? []).filter(
                    (m) => m.enabled !== false && m.status !== "deprecated",
                );
                const deduped = usable.filter((m, i) =>
                    usable.findIndex(
                        (o) => o.providerID === m.providerID && o.modelID === m.modelID,
                    ) === i
                );
                // Own providers first; catalog models only for catalog-only setups.
                const own = deduped.filter((m) => !catalogIds.has(m.providerID));
                const sortedOwn = own.slice().sort((a, b) =>
                    (b.released ?? 0) - (a.released ?? 0) || (a.name ?? a.id).localeCompare(b.name ?? b.id),
                );
                setModels(catalogOnly ? deduped : sortedOwn);
            });
        }).catch((e) => logError(`Failed to load models: ${e}`).catch(() => {}));

        api.listAgents().then((list) => {
            if (cancelled) return;
            setAgents((list ?? []).filter((a) => a.mode === "primary" && !a.hidden));
        }).catch((e) => logError(`Failed to load agents: ${e}`).catch(() => {}));
        api.getDefaultModel().then((m) => {
            if (cancelled) return;
            setDefaultModel(m ?? null);
        }).catch((e) => logError(`Failed to load default model: ${e}`).catch(() => {}));
        return () => {
            cancelled = true;
        };
    }, [api]);

    return {models, agents, defaultModel};
}
