import type {ReactNode} from "react";
import {Wrench} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import Hint from "../ui/Hint.tsx";
import {ProviderAvatar} from "./modelSettingsChrome.tsx";
import type {CustomProviderDef} from "./modelConfig.ts";
import type {IntegrationInfo} from "../../opencode/types.ts";

/**
 * The Model pane's provider NAV rail content — the grouped rows (connected
 * providers, custom providers, the fixed Tools entry) shared by BOTH
 * layouts: the desktop's left rail and the phone layout's root page
 * (ModelSettings). The pane-level state (selection, loading, errors)
 * stays with ModelSettings; this component is pure presentation over it.
 */

/** The pane's selection state (the detail view's key). */
export type NavSelection =
    | {kind: "integration"; id: string}
    | {kind: "custom"; id: string}
    | {kind: "custom-new"}
    | {kind: "tools"};

function GroupLabel({children}: {children: ReactNode}) {
    const colors = useColors();
    return (
        <span className="block px-2 pt-3 pb-1 text-2xs leading-normal" style={{color: colors.inactiveText}}>
            {children}
        </span>
    );
}

/** One provider row of the nav rail: avatar + name + status dot (red =
 * provider-level disabled, green = connected, hollow grey = not yet
 * connected). The Tools entry hides the dot. */
function NavRow({
    selected,
    connected,
    disabled,
    hideDot,
    onClick,
    avatar,
    label,
}: {
    selected: boolean;
    connected: boolean;
    /** Provider-level disabled (the detail header's switch) — the dot
     * turns red; the provider stays in the rail with credentials. */
    disabled?: boolean;
    hideDot?: boolean;
    onClick: () => void;
    avatar: ReactNode;
    label: string;
}) {
    const colors = useColors();
    const t = useI18n();
    return (
        <Hint
            label={hideDot ? undefined : disabled ? t["Disabled"] : connected ? t["Connected"] : t["Not connected"]}
            className="w-full"
        >
            {/* No whileHoverTap: rows in the scrolling nav would clip at
             * the overflow boundary on scale — the hover wash IS the
             * affordance here (springs belong to button primitives). */}
            <button
                type="button"
                onClick={onClick}
                className={`flex items-center gap-2 w-full h-9 px-2 rounded-[var(--radius-md)] text-left cursor-pointer transition-colors duration-[var(--duration-fast)]${
                    selected ? "" : " hover:bg-[var(--lum-nav-hover)]"
                }`}
                style={
                    selected
                        ? {background: colors.activeOverlay}
                        : ({"--lum-nav-hover": colors.hoverOverlay} as React.CSSProperties)
                }
            >
                {avatar}
                <span className="min-w-0 flex-1 truncate text-xs leading-normal">{label}</span>
                {!hideDot && (
                    <span
                        className="w-1.5 h-1.5 rounded-full shrink-0 mr-1.5"
                        style={
                            disabled
                                ? {background: "var(--color-danger)"}
                                : connected
                                    ? {background: "var(--color-success)"}
                                    : {background: colors.inactiveText, opacity: 0.35}
                        }
                    />
                )}
            </button>
        </Hint>
    );
}

/** The rail's grouped rows (the pane's `navContent`). */
export default function ProviderNavRail({
    integrations,
    loadFailed,
    customDefs,
    disabledProviders,
    selected,
    onSelect,
}: {
    /** null = still loading. */
    integrations: IntegrationInfo[] | null;
    loadFailed: boolean;
    customDefs: CustomProviderDef[];
    /** Provider-level disable snapshots (ProviderDetail's switch): the
     *  keys are the disabled provider ids (the values are the hidden
     *  model snapshots for restore). */
    disabledProviders: ReadonlyMap<string, readonly string[]>;
    selected: NavSelection | null;
    onSelect: (selection: NavSelection) => void;
}) {
    const colors = useColors();
    const t = useI18n();
    return (
        <>
            <GroupLabel>{t["Providers"]}</GroupLabel>
            {integrations === null && !loadFailed && (
                <p className="px-2 text-2xs leading-relaxed" style={{color: colors.inactiveText}}>
                    {t["Loading..."]}
                </p>
            )}
            {loadFailed && (
                <p className="px-2 text-2xs leading-relaxed" style={{color: colors.inactiveText}}>
                    {t["Failed to load providers"]}
                </p>
            )}
            {(integrations ?? []).map((i) => (
                <NavRow
                    key={i.id}
                    selected={selected?.kind === "integration" && selected.id === i.id}
                    connected={i.connections.length > 0}
                    disabled={disabledProviders.has(i.id)}
                    onClick={() => {
                        onSelect({kind: "integration", id: i.id});
                    }}
                    avatar={<ProviderAvatar name={i.name} providerId={i.id}/>}
                    label={i.name}
                />
            ))}

            {/* Custom providers — the group hides entirely while empty
             * (nothing configured = no「自定义供应商」 header, no
             * placeholder; the Add modal's custom entry is the way in). */}
            {customDefs.length > 0 && (
                <>
                    <GroupLabel>{t["Custom providers"]}</GroupLabel>
                    {customDefs.map((d) => (
                        <NavRow
                            key={d.id}
                            selected={selected?.kind === "custom" && selected.id === d.id}
                            connected
                            onClick={() => {
                                onSelect({kind: "custom", id: d.id});
                            }}
                            avatar={<ProviderAvatar name={d.name || d.id} providerId={d.id} custom/>}
                            label={d.name || d.id}
                        />
                    ))}
                </>
            )}

            {/* Tools — the vision-model configuration; the nav's fixed
             * bottom entry (a pane-level concern, not a provider). */}
            <GroupLabel>{t["Tools"]}</GroupLabel>
            <NavRow
                selected={selected?.kind === "tools"}
                connected={false}
                hideDot
                onClick={() => {
                    onSelect({kind: "tools"});
                }}
                avatar={
                    <span
                        className="inline-flex items-center justify-center shrink-0 w-6 h-6 rounded-[var(--radius-sm)]"
                        style={{background: colors.activeOverlay, color: colors.inactiveText}}
                    >
                        <Wrench size={13}/>
                    </span>
                }
                label={t["Tools"]}
            />
        </>
    );
}
