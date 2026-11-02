import {useEffect, useState, type ReactNode} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {OpencodeModel} from "../../opencode/types.ts";

/**
 * Shared chrome for the Model pane's sub-views (ToolsTab /
 * ProviderDetail / CustomProviderForm / the pane shell): the labeled
 * form field, the accent status badge, and the listModels loading hook.
 * Extracted from ModelSettings.tsx when the pane split into files.
 */

/** A labeled form field. Div-based (not <label>) so the row can contain
 *  buttons without label-activation side effects. */
export function Field({label, children}: {label: string; children: ReactNode}) {
    const colors = useColors();
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{color: colors.inactiveText}}>{label}</span>
            {children}
        </div>
    );
}

/** The small accent-tinted status badge (Connected / Enabled / Active)
 *  — ONE look wherever the pane marks a live state (was four
 *  hand-rolled copies whose text colors had already drifted). */
export function AccentBadge({label}: {label: string}) {
    const colors = useColors();
    return (
        <span
            className="shrink-0 text-2xs px-1.5 py-0.5 rounded-[var(--radius-xs)]"
            style={{
                background: colors.accentOverlay,
                color: colors.dark ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.7)",
            }}
        >
            {label}
        </span>
    );
}

/** Load the model list through the api once per (api, deps) with the
 *  pane's shared cancel-safe shape — ToolsTab and ProviderDetail both
 *  filter the full list differently; the loading/failure handling is
 *  identical. `filter` runs on the raw list; `deps` refetch when they
 *  change (ProviderDetail passes the integration's connections so a
 *  fresh credential refetches its models). */
export function useModelsList(
    api: OpencodeApi | null,
    filter: (models: OpencodeModel[]) => OpencodeModel[],
    deps: unknown[] = [],
): {models: OpencodeModel[] | null; modelsFailed: boolean} {
    const [models, setModels] = useState<OpencodeModel[] | null>(null);
    const [modelsFailed, setModelsFailed] = useState(false);
    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        api.listModels().then((list) => {
            if (cancelled) return;
            setModels(filter(list ?? []));
            setModelsFailed(false);
        }).catch((e) => {
            if (cancelled) return;
            setModelsFailed(true);
            logError(`Failed to list models: ${e}`).catch(() => {});
        });
        return () => {
            cancelled = true;
        };
        // The filter/deps are the caller's refetch contract (mirrors the
        // hand-rolled effect this replaced).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, ...deps]);
    return {models, modelsFailed};
}
