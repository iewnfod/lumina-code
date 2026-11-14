import {useEffect, useMemo, useState} from "react";
import {Box, Search} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useScrollEdges, fadeClasses} from "../../hooks/useScrollEdges.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import type {IntegrationInfo} from "../../opencode/types.ts";
import Modal from "../ui/Modal.tsx";
import {filterIntegrations} from "./modelConfig.ts";
import {AccentBadge, ProviderAvatar} from "./modelSettingsChrome.tsx";

/**
 * The「+ 添加供应商」picker: the FULL integration catalog (the server
 * knows ~226) with search — the discovery surface the pane's left nav
 * deliberately omits (the nav lists only configured providers). Picking
 * an integration selects it in the pane (its detail shows the connect
 * forms); the custom entry hands the caller a blank custom-provider
 * draft instead.
 */
export default function AddProviderModal({
    open,
    onClose,
    integrations,
    onPickIntegration,
    onPickCustom,
}: {
    open: boolean;
    onClose: () => void;
    /** The full integration list (null while loading). */
    integrations: IntegrationInfo[] | null;
    onPickIntegration: (id: string) => void;
    onPickCustom: () => void;
}) {
    const colors = useColors();
    const t = useI18n();
    const [query, setQuery] = useState("");
    const edges = useScrollEdges<HTMLDivElement>();

    useEffect(() => {
        if (open) setQuery("");
    }, [open]);

    const visible = useMemo(
        () => (integrations ? filterIntegrations(integrations, query) : []),
        [integrations, query],
    );

    return (
        <Modal open={open} onClose={onClose} title={t["Add provider"]}>
            <div className="flex flex-col gap-2.5 p-4 min-w-0 overflow-x-hidden">
                {/* Pinned search — the pattern the old flat list used. */}
                <label
                    className="flex items-center gap-2 h-9 px-3 rounded-[var(--radius-sm)]"
                    style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
                >
                    <Search size={14} className="shrink-0 opacity-45"/>
                    <input
                        type="text"
                        value={query}
                        placeholder={t["Search providers..."]}
                        onChange={(e) => setQuery(e.currentTarget.value)}
                        className="w-full bg-transparent text-sm outline-none placeholder:opacity-40"
                    />
                </label>
                <div
                    ref={edges.ref}
                    onScroll={edges.onScroll}
                    className={`lum-fade-md flex flex-col min-h-0 max-h-[50vh] overflow-y-auto overflow-x-hidden${fadeClasses(edges)}`}
                >
                    {integrations === null && (
                        <p className="text-xs py-4 text-center" style={{color: colors.inactiveText}}>
                            {t["Loading..."]}
                        </p>
                    )}
                    {integrations !== null && visible.length === 0 && (
                        <p className="text-xs py-4 text-center" style={{color: colors.inactiveText}}>
                            {t["No matching providers"]}
                        </p>
                    )}
                    {visible.map((i) => (
                        // No whileHoverTap on rows: the scale would clip at
                        // the scrolling list's overflow boundary — the
                        // hover wash is the affordance.
                        <button
                            key={i.id}
                            type="button"
                            onClick={() => {
                                onPickIntegration(i.id);
                                onClose();
                            }}
                            className="flex items-center gap-2 w-full px-2.5 py-2 rounded-[var(--radius-sm)] text-left cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-row-hover)]"
                            style={{"--lum-row-hover": colors.hoverOverlay} as React.CSSProperties}
                        >
                            <ProviderAvatar name={i.name} providerId={i.id} size={22}/>
                            <span className="min-w-0 flex-1 truncate leading-normal text-xs">{i.name}</span>
                            {i.connections.some((c) => c.type === "credential") && (
                                <AccentBadge label={t["Connected"]}/>
                            )}
                        </button>
                    ))}
                </div>
                {/* The custom-provider entry: a bottom rail separated from
                 * the catalog — a different kind of pick (a blank draft,
                 * not an existing integration). */}
                <div className="border-t pt-2" style={{borderColor: colors.glassBorder}}>
                    <button
                        type="button"
                        onClick={() => {
                            onPickCustom();
                            onClose();
                        }}
                        className="flex items-center gap-2 w-full px-2.5 py-2 rounded-[var(--radius-sm)] text-left cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-row-hover)]"
                        style={{"--lum-row-hover": colors.hoverOverlay} as React.CSSProperties}
                    >
                        <span
                            className="inline-flex items-center justify-center shrink-0 w-[22px] h-[22px] rounded-[var(--radius-sm)]"
                            style={{background: colors.activeOverlay, color: colors.inactiveText}}
                        >
                            <Box size={13}/>
                        </span>
                        <span className="min-w-0 flex-1 truncate leading-normal text-xs">
                            {t["Custom provider"]}
                        </span>
                        <span className="shrink-0 text-2xs" style={{color: colors.inactiveText}}>
                            {t["OpenAI-compatible endpoint"]}
                        </span>
                    </button>
                </div>
            </div>
        </Modal>
    );
}
