import {useEffect, useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {OpencodeAgent, OpencodeModel, OpencodeProvider} from "./types.ts";

/**
 * A provider whose models come from the free public catalog (OpenCode Zen)
 * rather than the user's own credentials — detected by the baked-in public
 * API key. Those models are hidden unless they're all the user has.
 */
function isCatalogProvider(settings?: {apiKey?: string}): boolean {
    return settings?.apiKey === "public";
}

/**
 * The provider list with a short retry. A second opencode instance (the
 * CLI, another app) can transiently hold the shared storage lock, making
 * this read come back EMPTY — and an empty list must not leak into the
 * filter logic: `every()` is vacuously true on [], which would silently
 * unhide the whole free catalog. Retrying bridges the transient; a final
 * empty read surfaces as a failed load (empty picker) instead.
 */
async function loadProviders(api: OpencodeApi, attempts = 5, delayMs = 1000): Promise<OpencodeProvider[]> {
    for (let i = 0; ; i++) {
        const providers = (await api.listProviders()) ?? [];
        if (providers.length > 0) return providers;
        if (i >= attempts - 1) throw new Error("provider list came back empty");
        await new Promise((r) => setTimeout(r, delayMs));
    }
}

/**
 * The agent list with the same transient-empty retry as {@link loadProviders}:
 * a concurrent opencode instance can briefly hold the shared storage lock and
 * make `/api/agent` come back empty (or fail), which would otherwise leave the
 * mode picker with nothing to select.
 */
async function loadAgents(api: OpencodeApi, attempts = 5, delayMs = 1000): Promise<OpencodeAgent[]> {
    for (let i = 0; ; i++) {
        try {
            const agents = ((await api.listAgents()) ?? []).filter((a) => a.mode === "primary" && !a.hidden);
            if (agents.length > 0) return agents;
        } catch {
            // retried below
        }
        if (i >= attempts - 1) return [];
        await new Promise((r) => setTimeout(r, delayMs));
    }
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
 *
 * The catalog also reloads whenever credentials or config change on the
 * server (`credential.updated` / `config.updated` — connecting an API key
 * in the model-config modal, writing custom providers, `opencode auth` in
 * a terminal…) via a revision counter fed by the event bus.
 */
export function useModelCatalog(
    api: OpencodeApi | null,
    subscribe: ((handler: OpencodeEventHandler) => () => void) | null,
): {
    models: OpencodeModel[];
    /** User-selectable modes: primary, non-hidden agents (build/plan/…). */
    agents: OpencodeAgent[];
    defaultModel: OpencodeModel | null;
    /** True when the ONLY provider is the free catalog — the user has no
     * authenticated provider of their own (drives the picker's empty state). */
    catalogOnly: boolean;
} {
    const [models, setModels] = useState<OpencodeModel[]>([]);
    const [agents, setAgents] = useState<OpencodeAgent[]>([]);
    const [defaultModel, setDefaultModel] = useState<OpencodeModel | null>(null);
    const [catalogOnly, setCatalogOnly] = useState(false);
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        if (!subscribe) return;
        return subscribe((event) => {
            // Payloads are empty on this server generation — bump and refetch.
            if (event.type === "credential.updated" || event.type === "config.updated") {
                setRevision((r) => r + 1);
            }
        });
    }, [subscribe]);

    useEffect(() => {
        if (!api) return;
        let cancelled = false;

        loadProviders(api).then((providers) => {
            if (cancelled) return;
            const onlyCatalog = providers.every((p) => isCatalogProvider(p.settings));
            setCatalogOnly(onlyCatalog);
            const catalogIds = new Set(
                providers.filter((p) => isCatalogProvider(p.settings)).map((p) => p.id),
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
                setModels(onlyCatalog ? deduped : sortedOwn);
            });
        }).catch((e) => logError(`Failed to load models: ${e}`).catch(() => {}));

        loadAgents(api).then((list) => {
            if (cancelled) return;
            setAgents(list);
        }).catch((e) => logError(`Failed to load agents: ${e}`).catch(() => {}));
        api.getDefaultModel().then((m) => {
            if (cancelled) return;
            setDefaultModel(m ?? null);
        }).catch((e) => logError(`Failed to load default model: ${e}`).catch(() => {}));
        return () => {
            cancelled = true;
        };
    }, [api, revision]);

    return {models, agents, defaultModel, catalogOnly};
}
