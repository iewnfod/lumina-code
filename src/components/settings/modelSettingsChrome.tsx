import {useEffect, useState, type ReactNode} from "react";
import {Box} from "lucide-react";
import {error as logError} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import type {OpencodeApi} from "../../opencode/api/index.ts";
import type {OpencodeModel} from "../../opencode/types.ts";
import {providerAvatarColor} from "./modelConfig.ts";

/**
 * Shared chrome for the Model pane's sub-views (ToolsTab /
 * ProviderDetail / CustomProviderDetail / the pane shell): the labeled
 * form field, the accent status badge, the provider avatar, the model
 * row's neutral badge, and the listModels loading hook.
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

/** The neutral pill badge a model row carries beside its name (the
 * context-limit "1M" / the「视觉」capability) — the same look the
 * composer's model picker badges vision models with. */
export function ModelBadge({label}: {label: string}) {
    const colors = useColors();
    return (
        <span
            className="shrink-0 rounded-full px-1.5 py-1 text-2xs leading-none"
            style={{background: colors.activeOverlay, color: colors.inactiveText}}
        >
            {label}
        </span>
    );
}

/** A quiet inline text action (the model lists'「全部开启/全部禁用」)
 * — the labeled button's 2xs sibling for header rows where a full
 * Button would outweigh the title it sits beside. */
export function TextAction({label, onClick, disabled}: {label: string; onClick: () => void; disabled?: boolean}) {
    const colors = useColors();
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="shrink-0 h-6 px-1.5 rounded-[var(--radius-xs)] text-2xs leading-none cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-text-action-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            style={
                {
                    color: colors.inactiveText,
                    "--lum-text-action-hover": colors.hoverOverlay,
                } as React.CSSProperties
            }
        >
            {label}
        </button>
    );
}

/** A provider's identity mark. Official integrations get a colored
 * initial (hue hashed from the id, stable across renders); custom
 * providers get the wireframe cube the design calls for. `size` is the
 * box's pixel edge (nav rows 24, detail headers 36). */
export function ProviderAvatar({name, providerId, custom, size = 24}: {
    name: string;
    providerId: string;
    /** Custom providers render the cube glyph on a neutral chip. */
    custom?: boolean;
    size?: number;
}) {
    const colors = useColors();
    if (custom) {
        return (
            <span
                className="inline-flex items-center justify-center shrink-0 rounded-[var(--radius-sm)]"
                style={{
                    width: size,
                    height: size,
                    background: colors.activeOverlay,
                    color: colors.inactiveText,
                }}
            >
                <Box size={Math.round(size * 0.6)}/>
            </span>
        );
    }
    const initial = (name.trim()[0] ?? "?").toUpperCase();
    return (
        <span
            aria-hidden
            className="inline-flex items-center justify-center shrink-0 rounded-[var(--radius-sm)] font-semibold text-white select-none"
            style={{
                width: size,
                height: size,
                background: providerAvatarColor(providerId, colors.dark),
                fontSize: Math.max(10, Math.round(size * 0.45)),
            }}
        >
            {initial}
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
