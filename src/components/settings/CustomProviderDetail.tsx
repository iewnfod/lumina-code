import {useEffect, useState} from "react";
import {Check, ChevronDown, Eye, EyeOff, MoreHorizontal, Pencil, Trash2, X} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {
    disabledModelKey,
    disableProvider,
    enableProvider,
    setModelDisabled,
    setModelsDisabled,
    useDisabledModels,
    useDisabledProviders,
} from "../../hooks/useDisabledModels.ts";
import type {OpencodeModel} from "../../opencode/types.ts";
import Button from "../ui/Button.tsx";
import IconButton from "../ui/IconButton.tsx";
import Hint from "../ui/Hint.tsx";
import PopoverMenu, {MenuItem} from "../ui/PopoverMenu.tsx";
import {API_FORMATS, DEFAULT_MODEL_OUTPUT, apiFormatId, formatContextLimit, parseLimitInput, providerModels} from "./modelConfig.ts";
import {Field, ModelBadge, ProviderAvatar, TextAction, useModelsList} from "./modelSettingsChrome.tsx";
import type {CustomProviderDef, CustomProviderModelDef} from "./modelConfig.ts";
import type {OpencodeApi} from "../../opencode/api/index.ts";
import TextInput from "./TextInput.tsx";
import Switch from "./Switch.tsx";

/**
 * One CUSTOM provider's detail page (the design mock's Deepseek form):
 * header (cube avatar + name + the ⋯ menu with Delete), the inline
 * fields (display name, Base URL, the API-format picker, the API key
 * with show/hide — stored as `options.apiKey`, plaintext in the config
 * file), and the model-list card with per-row inline editing. MODEL
 * LIST CHANGES COMMIT IMMEDIATELY — ✓/add/remove write the config on
 * the spot (a brand-new provider draft keeps the save-button flow) —
 * while the provider-level fields wait for the 保存 button.
 */
export default function CustomProviderDetail({
    def,
    isNew,
    api,
    busy,
    onCancelNew,
    onSave,
    onDelete,
}: {
    /** The config's current def, or the blank draft for a new provider. */
    def: CustomProviderDef;
    isNew: boolean;
    api: OpencodeApi | null;
    busy: boolean;
    /** Leave a blank draft without saving. */
    onCancelNew: () => void;
    onSave: (def: CustomProviderDef) => void;
    /** Delete this provider from the config (hidden for drafts). */
    onDelete: (id: string) => void;
}) {
    const colors = useColors();
    const t = useI18n();
    const [draft, setDraft] = useState<CustomProviderDef>(def);
    const [showKey, setShowKey] = useState(false);
    /** Which model row is in inline-edit mode (index into draft.models;
     * null = none). */
    const [editIndex, setEditIndex] = useState<number | null>(null);
    const [editId, setEditId] = useState("");
    const [editName, setEditName] = useState("");
    // The capability fields, editor-string flavored (limit) and tri-stated
    // (vision: both API packages default to image input, verified live, so
    // an unset row still edits as ON — committing it back changes nothing).
    const [editCtx, setEditCtx] = useState("");
    const [editOut, setEditOut] = useState("");
    const [editVision, setEditVision] = useState(true);

    const set = (patch: Partial<CustomProviderDef>) => setDraft((prev) => ({...prev, ...patch}));

    /** Model-list changes COMMIT IMMEDIATELY: ✓/remove write the config the
     * moment they land (top-level provider fields — name/URL/key — keep
     * their explicit 保存). A brand-new provider draft cannot auto-save
     * (validation needs the still-being-typed fields), so it keeps the
     * save-button flow. Based on the SAVED def so unsaved top-level edits
     * stay in the draft. */
    const commitModels = (models: CustomProviderModelDef[]) => {
        setDraft((prev) => ({...prev, models}));
        if (!isNew) onSave({...def, models});
    };

    // The server's view of this provider's models (when it has loaded
    // the config entry) — feeds the picker-visibility Switch (and the
    // enable/disable-all bulk actions). NOT the badges: those read the
    // draft, which commits immediately while this mirror lags the hot
    // reload (see commitModels).
    const {models} = useModelsList(api, (list) => providerModels(list, def.id), [def.id, def.models.length]);

    // The provider-level disable — the same client-side store the
    // official providers' header switch writes (presence = disabled,
    // payload = the hidden-models snapshot a re-enable restores).
    const disabledProviders = useDisabledProviders();
    const providerDisabled = !isNew && disabledProviders.has(def.id);
    const disabledModels = useDisabledModels();

    // Self-heal: while disabled, nothing of this provider may leak into
    // the picker — models configured (or listed) after the disable get
    // swept in (row edits still write the config underneath). Idempotent;
    // settles after one pass.
    useEffect(() => {
        if (!providerDisabled || models == null) return;
        const missing = models.filter((m) => !disabledModels.has(disabledModelKey(m.providerID, m.modelID)));
        if (missing.length > 0) setModelsDisabled(missing, true);
    }, [providerDisabled, models, disabledModels]);

    const dirty = JSON.stringify(draft) !== JSON.stringify(def);
    const format = apiFormatId(draft.npm);
    const formatLabel =
        format === "openai" ? t["OpenAI compatible"]
        : format === "anthropic" ? t["Anthropic Messages"]
        : draft.npm;

    const beginEdit = (index: number) => {
        const m = draft.models[index];
        setEditId(m.id);
        setEditName(m.name ?? "");
        setEditCtx(m.limit ? String(m.limit.context) : "");
        setEditOut(m.limit ? String(m.limit.output) : "");
        setEditVision(m.vision ?? true);
        setEditIndex(index);
    };
    const commitEdit = () => {
        if (editIndex == null) return;
        const id = editId.trim();
        const limit = parseLimitInput(editCtx, editOut);
        // An empty id on commit drops the row (the natural end of "add
        // then back out"); anything else replaces the row wholesale —
        // clearing a field clears it from the config too.
        commitModels(
            id === ""
                ? draft.models.filter((_, i) => i !== editIndex)
                : draft.models.map((m, i) =>
                    i === editIndex
                        ? {
                            id,
                            ...(editName.trim() ? {name: editName.trim()} : {}),
                            ...(limit ? {limit} : {}),
                            vision: editVision,
                        }
                        : m
                )
        );
        setEditIndex(null);
    };

    const modelCount = draft.models.filter((m) => m.id.trim() !== "").length;

    return (
        <div className="flex flex-col gap-5">
            {/* Header — cube avatar + name + the ⋯ menu. */}
            <div className="flex items-center gap-3">
                <ProviderAvatar name={draft.name || draft.id || "?"} providerId={def.id} custom size={36}/>
                <span className="min-w-0 flex-1 truncate text-xl font-semibold leading-normal">
                    {isNew ? t["Add custom provider"] : (draft.name || draft.id)}
                </span>
                {/* The provider-level disable switch — the same client-side
                 * mechanism the official providers carry (see
                 * ProviderDetail's twin): OFF snapshots which models were
                 * already hidden, hides them all and LOCKS the rows'
                 * visibility switches below; ON restores the snapshot, so
                 * per-model choices survive the round trip. Needs the
                 * server's model list, so a draft or an unloaded provider
                 * hides it. */}
                {!isNew && models != null && models.length > 0 && (
                    <Hint label={t["Disabling hides this provider's models from the picker; credentials are kept"]}>
                        <Switch
                            checked={!providerDisabled}
                            label={t["Show in model picker"]}
                            onChange={(on) => {
                                if (on) enableProvider(def.id);
                                else disableProvider(def.id, models.map((m) => m.modelID));
                            }}
                        />
                    </Hint>
                )}
                {!isNew && (
                    <PopoverMenu
                        panelClassName="w-44"
                        align="end"
                        direction="down"
                        trigger={({open, toggle}) => (
                            <IconButton
                                size={28}
                                hoverOverlay={colors.hoverOverlay}
                                activeOverlay={colors.activeOverlay}
                                isActive={open}
                                aria-label={t["Delete provider"]}
                                onClick={toggle}
                            >
                                <MoreHorizontal size={15}/>
                            </IconButton>
                        )}
                    >
                        {(close) => (
                            <MenuItem
                                danger
                                onClick={() => {
                                    close();
                                    onDelete(def.id);
                                }}
                            >
                                {t["Delete provider"]}
                            </MenuItem>
                        )}
                    </PopoverMenu>
                )}
            </div>

            {/* Fields. */}
            {isNew && (
                <Field label={t["Provider ID"]}>
                    <TextInput
                        value={draft.id}
                        mono
                        placeholder="my-provider"
                        onChange={(id) => set({id})}
                    />
                </Field>
            )}
            <Field label={t["Display name"]}>
                <TextInput
                    value={draft.name}
                    placeholder={draft.id || "My Provider"}
                    onChange={(name) => set({name})}
                />
            </Field>
            <Field label={t["Base URL"]}>
                <TextInput
                    value={draft.baseURL}
                    mono
                    placeholder="https://api.example.com/v1"
                    onChange={(baseURL) => set({baseURL})}
                />
            </Field>
            <Field label={t["API format"]}>
                <PopoverMenu
                    panelClassName="w-64"
                    trigger={({toggle}) => (
                        <button
                            type="button"
                            onClick={toggle}
                            className="flex items-center gap-2 h-9 w-full px-3 rounded-[var(--radius-sm)] text-sm cursor-pointer"
                            style={{
                                background: colors.recessedBg,
                                border: `1px solid ${colors.glassBorder}`,
                                color: format === "custom" ? colors.inactiveText : undefined,
                            }}
                        >
                            <span className="min-w-0 flex-1 truncate text-left">{formatLabel}</span>
                            <ChevronDown size={14} className="shrink-0 opacity-60"/>
                        </button>
                    )}
                >
                    {(close) => (
                        <>
                            {API_FORMATS.map((f) => (
                                <MenuItem
                                    key={f.id}
                                    selected={format === f.id}
                                    onClick={() => {
                                        set({npm: f.npm});
                                        close();
                                    }}
                                >
                                    {f.id === "openai" ? t["OpenAI compatible"] : t["Anthropic Messages"]}
                                </MenuItem>
                            ))}
                            {format === "custom" && (
                                <MenuItem selected onClick={close}>
                                    {t["Custom package"]}: {draft.npm}
                                </MenuItem>
                            )}
                        </>
                    )}
                </PopoverMenu>
            </Field>
            <Field label={t["API key"]}>
                <div className="flex items-center gap-1.5">
                    <TextInput
                        value={draft.apiKey ?? ""}
                        type={showKey ? "text" : "password"}
                        placeholder={t["Paste your API key"]}
                        autoComplete="off"
                        onChange={(apiKey) => set({apiKey})}
                    />
                    <Hint label={showKey ? t["Hide API key"] : t["Show API key"]} className="shrink-0">
                        <IconButton
                            size={36}
                            hoverOverlay={colors.hoverOverlay}
                            activeOverlay={colors.activeOverlay}
                            aria-label={showKey ? t["Hide API key"] : t["Show API key"]}
                            onClick={() => setShowKey((v) => !v)}
                        >
                            {showKey ? <EyeOff size={15}/> : <Eye size={15}/>}
                        </IconButton>
                    </Hint>
                </div>
                <p className="text-2xs leading-relaxed" style={{color: colors.inactiveText}}>
                    {t["API key is stored in the config file in plaintext"]}
                </p>
            </Field>

            {/* The model-list card. */}
            <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1 min-w-0">
                        <span className="text-xs font-medium">
                            {t["Model list"]}
                            {modelCount > 0 && (
                                <span className="ml-1.5 font-normal" style={{color: colors.inactiveText}}>
                                    {modelCount}
                                </span>
                            )}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        {models != null && models.length > 0 && (
                            <>
                                {/* Locked while the provider-level disable is
                                 * on: the header switch owns the whole list
                                 * (and restores the snapshot), so bulk
                                 * toggles underneath would only corrupt it. */}
                                <TextAction
                                    label={t["Enable all"]}
                                    disabled={providerDisabled}
                                    onClick={() => setModelsDisabled(models, false)}
                                />
                                <TextAction
                                    label={t["Disable all"]}
                                    disabled={providerDisabled}
                                    onClick={() => setModelsDisabled(models, true)}
                                />
                            </>
                        )}
                        <Button
                            size="sm"
                            label={t["Add model"]}
                            disabled={editIndex != null}
                            onClick={() => {
                                setDraft((prev) => ({...prev, models: [...prev.models, {id: "", name: ""}]}));
                                setEditId("");
                                setEditName("");
                                setEditCtx("");
                                setEditOut("");
                                setEditVision(true);
                                setEditIndex(draft.models.length);
                            }}
                        />
                    </div>
                </div>
                {draft.models.length > 0 && (
                    <div
                        className="flex flex-col rounded-[var(--radius-lg)] overflow-hidden"
                        style={{border: `1px solid ${colors.glassBorder}`}}
                    >
                        {draft.models.map((m, index) => (
                            <CustomModelRow
                                key={index}
                                first={index === 0}
                                modelId={m.id}
                                modelName={m.name}
                                modelLimit={m.limit}
                                modelVision={m.vision}
                                serverModel={models?.find((sm) => sm.modelID === m.id) ?? null}
                                locked={providerDisabled}
                                editing={editIndex === index}
                                editId={editId}
                                editName={editName}
                                editCtx={editCtx}
                                editOut={editOut}
                                editVision={editVision}
                                onEditId={setEditId}
                                onEditName={setEditName}
                                onEditCtx={setEditCtx}
                                onEditOut={setEditOut}
                                onEditVision={setEditVision}
                                onCommit={commitEdit}
                                onCancel={() => {
                                    // An untouched new row disappears; an
                                    // existing row keeps its stored values.
                                    if (m.id === "" ) {
                                        setDraft((prev) => ({...prev, models: prev.models.filter((_, i) => i !== index)}));
                                    }
                                    setEditIndex(null);
                                }}
                                onBeginEdit={() => beginEdit(index)}
                                onRemove={() => {
                                    commitModels(draft.models.filter((_, i) => i !== index));
                                    if (editIndex === index) setEditIndex(null);
                                }}
                            />
                        ))}
                    </div>
                )}
            </section>

            {/* Save row. */}
            <div className="flex items-center gap-2">
                <Button
                    label={t["Save"]}
                    primary
                    disabled={busy || !dirty || editIndex != null}
                    onClick={() => onSave(draft)}
                />
                {isNew && <Button label={t["Cancel"]} onClick={onCancelNew}/>}
            </div>

            <p className="text-2xs" style={{color: colors.inactiveText}}>
                {t["Custom providers are stored in the global OpenCode config"]}
            </p>
        </div>
    );
}

/** One model row of the custom-provider detail: mono id (+ name), the
 * context / vision badges read from the DRAFT values (what the config
 * says or will say the instant the row commits — model edits save
 * immediately, and the server's mirror lags the hot reload), inline
 * edit (pencil), remove (bin), and the picker-visibility switch (the
 * one part that still needs the server's loaded view of the model). */
function CustomModelRow({
    modelId,
    modelName,
    modelLimit,
    modelVision,
    serverModel,
    locked,
    first,
    editing,
    editId,
    editName,
    editCtx,
    editOut,
    editVision,
    onEditId,
    onEditName,
    onEditCtx,
    onEditOut,
    onEditVision,
    onBeginEdit,
    onCommit,
    onCancel,
    onRemove,
}: {
    modelId: string;
    modelName?: string;
    modelLimit?: {context: number; output: number};
    modelVision?: boolean;
    /** The server's entry for this model, when it has loaded the config
     * — the badges' data source (null = none/no badges). */
    serverModel: OpencodeModel | null;
    /** Freezes the picker-visibility switch while the provider-level
     * disable owns the whole list (edits keep working underneath). */
    locked: boolean;
    first: boolean;
    editing: boolean;
    editId: string;
    editName: string;
    editCtx: string;
    editOut: string;
    editVision: boolean;
    onEditId: (v: string) => void;
    onEditName: (v: string) => void;
    onEditCtx: (v: string) => void;
    onEditOut: (v: string) => void;
    onEditVision: (v: boolean) => void;
    onBeginEdit: () => void;
    onCommit: () => void;
    onCancel: () => void;
    onRemove: () => void;
}) {
    const colors = useColors();
    const t = useI18n();
    const disabledModels = useDisabledModels();
    const key = serverModel ? disabledModelKey(serverModel.providerID, serverModel.modelID) : null;
    const enabled = key == null || !disabledModels.has(key);
    // Badges read the DRAFT values — they are what the config says (or
    // will say the instant the row commits: model edits save immediately,
    // so the badge reflects the ✓ right away), while the server's mirror
    // lags the ~2s hot reload and this list only re-pulls it on
    // remount/length changes. Vision defaults to shown because both API
    // packages default to image input (verified live on v2.0.11).
    const contextBadge = formatContextLimit(modelLimit?.context);
    const vision = modelVision !== false;

    if (editing) {
        return (
            <div
                className={`flex flex-col gap-1.5 px-2.5 py-2${first ? "" : " border-t"}`}
                style={first ? undefined : {borderColor: "var(--lum-neutral-hairline)"}}
            >
                <div className="flex items-center gap-1.5">
                    <TextInput value={editId} mono placeholder={t["Model ID"]} onChange={onEditId}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing) onCommit();
                        }}/>
                    <TextInput value={editName} placeholder={t["Model name"]} onChange={onEditName}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing) onCommit();
                        }}/>
                    <Hint label={t["Save"]} className="shrink-0">
                        <IconButton
                            size={30}
                            hoverOverlay={colors.hoverOverlay}
                            activeOverlay={colors.activeOverlay}
                            aria-label={t["Save"]}
                            onClick={onCommit}
                        >
                            <Check size={14}/>
                        </IconButton>
                    </Hint>
                    <Hint label={t["Cancel"]} className="shrink-0">
                        <IconButton
                            size={30}
                            hoverOverlay={colors.hoverOverlay}
                            activeOverlay={colors.activeOverlay}
                            aria-label={t["Cancel"]}
                            onClick={onCancel}
                        >
                            <X size={14}/>
                        </IconButton>
                    </Hint>
                </div>
                {/* Capability row: token limits (both required by the server
                 * when set — output alone adopts the documented default) and
                 * the image-input override. */}
                <div className="flex items-center gap-1.5">
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span className="shrink-0 text-2xs" style={{color: colors.inactiveText}}>
                            {t["Context length"]}
                        </span>
                        <TextInput value={editCtx} inputMode="numeric" placeholder="200000" onChange={onEditCtx}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.nativeEvent.isComposing) onCommit();
                            }}/>
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span className="shrink-0 text-2xs" style={{color: colors.inactiveText}}>
                            {t["Max output"]}
                        </span>
                        <TextInput value={editOut} inputMode="numeric" placeholder={String(DEFAULT_MODEL_OUTPUT)} onChange={onEditOut}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.nativeEvent.isComposing) onCommit();
                            }}/>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <span className="text-2xs" style={{color: colors.inactiveText}}>
                            {t["Vision support"]}
                        </span>
                        <Switch
                            checked={editVision}
                            label={t["Vision support"]}
                            onChange={onEditVision}
                        />
                    </div>
                </div>
            </div>
        );
    }
    return (
        <div
            className={`flex items-center gap-2 px-2.5 py-2.5${first ? "" : " border-t"}`}
            style={first ? undefined : {borderColor: "var(--lum-neutral-hairline)"}}
        >
            <span className="min-w-0 flex flex-1 flex-col">
                <span className="min-w-0 truncate text-xs leading-normal font-mono">{modelId}</span>
                {modelName && (
                    <span className="min-w-0 truncate text-2xs leading-normal" style={{color: colors.inactiveText}}>
                        {modelName}
                    </span>
                )}
            </span>
            {contextBadge && <ModelBadge label={contextBadge}/>}
            {vision && <ModelBadge label={t["Vision"]}/>}
            <Hint label={t["Edit model"]}>
                <IconButton
                    size={24}
                    hoverOverlay={colors.hoverOverlay}
                    activeOverlay={colors.activeOverlay}
                    aria-label={t["Edit model"]}
                    onClick={onBeginEdit}
                >
                    <Pencil size={13}/>
                </IconButton>
            </Hint>
            <Hint label={t["Remove"]}>
                <IconButton
                    size={24}
                    hoverOverlay={colors.hoverOverlay}
                    activeOverlay={colors.activeOverlay}
                    aria-label={t["Remove"]}
                    onClick={onRemove}
                >
                    <Trash2 size={13}/>
                </IconButton>
            </Hint>
            {key != null && (
                <Switch
                    checked={enabled}
                    disabled={locked}
                    label={enabled ? t["Enabled"] : t["Disabled"]}
                    onChange={(next) => setModelDisabled(serverModel!.providerID, serverModel!.modelID, !next)}
                />
            )}
        </div>
    );
}
