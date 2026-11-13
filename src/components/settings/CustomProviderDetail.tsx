import {useState} from "react";
import {Check, ChevronDown, Eye, EyeOff, MoreHorizontal, Pencil, Trash2, X} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {disabledModelKey, setModelDisabled, setModelsDisabled, useDisabledModels} from "../../hooks/useDisabledModels.ts";
import type {OpencodeModel} from "../../opencode/types.ts";
import Button from "../ui/Button.tsx";
import IconButton from "../ui/IconButton.tsx";
import Hint from "../ui/Hint.tsx";
import PopoverMenu, {MenuItem} from "../ui/PopoverMenu.tsx";
import {API_FORMATS, apiFormatId, formatContextLimit, modelSupportsImage, providerModels} from "./modelConfig.ts";
import {Field, ModelBadge, ProviderAvatar, TextAction, useModelsList} from "./modelSettingsChrome.tsx";
import type {CustomProviderDef} from "./modelConfig.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import TextInput from "./TextInput.tsx";
import Switch from "./Switch.tsx";

/**
 * One CUSTOM provider's detail page (the design mock's Deepseek form):
 * header (cube avatar + name + the ⋯ menu with Delete), the inline
 * fields (display name, Base URL, the API-format picker, the API key
 * with show/hide — stored as `options.apiKey`, plaintext in the config
 * file), and the model-list card with per-row inline editing. A draft
 * (`isNew`, the Add modal's custom pick) additionally edits the
 * Provider ID; nothing is written until 保存 saves the whole def
 * through the pane's shared config write.
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

    const set = (patch: Partial<CustomProviderDef>) => setDraft((prev) => ({...prev, ...patch}));

    // The server's view of this provider's models (when it has loaded
    // the config entry) — the source for the context / vision badges.
    const {models} = useModelsList(api, (list) => providerModels(list, def.id), [def.id, def.models.length]);

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
        setEditIndex(index);
    };
    const commitEdit = () => {
        if (editIndex == null) return;
        const id = editId.trim();
        setDraft((prev) => {
            if (id === "") {
                // An empty id on commit drops the row (the natural end of
                // "add then back out").
                return {...prev, models: prev.models.filter((_, i) => i !== editIndex)};
            }
            return {
                ...prev,
                models: prev.models.map((m, i) => (i === editIndex ? {id, ...(editName.trim() ? {name: editName.trim()} : {})} : m)),
            };
        });
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
                        {models != null && models.length > 0 && (
                            <>
                                <TextAction
                                    label={t["Enable all"]}
                                    onClick={() => setModelsDisabled(models, false)}
                                />
                                <TextAction
                                    label={t["Disable all"]}
                                    onClick={() => setModelsDisabled(models, true)}
                                />
                            </>
                        )}
                    </div>
                    <Button
                        size="sm"
                        label={t["Add model"]}
                        disabled={editIndex != null}
                        onClick={() => {
                            setDraft((prev) => ({...prev, models: [...prev.models, {id: "", name: ""}]}));
                            setEditId("");
                            setEditName("");
                            setEditIndex(draft.models.length);
                        }}
                    />
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
                                serverModel={models?.find((sm) => sm.modelID === m.id) ?? null}
                                editing={editIndex === index}
                                editId={editId}
                                editName={editName}
                                onEditId={setEditId}
                                onEditName={setEditName}
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
                                    setDraft((prev) => ({...prev, models: prev.models.filter((_, i) => i !== index)}));
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
 * context / vision badges the server reports for it, inline edit
 * (pencil), remove (bin), and the picker-visibility switch. */
function CustomModelRow({
    modelId,
    modelName,
    serverModel,
    first,
    editing,
    editId,
    editName,
    onEditId,
    onEditName,
    onBeginEdit,
    onCommit,
    onCancel,
    onRemove,
}: {
    modelId: string;
    modelName?: string;
    /** The server's entry for this model, when it has loaded the config
     * — the badges' data source (null = none/no badges). */
    serverModel: OpencodeModel | null;
    first: boolean;
    editing: boolean;
    editId: string;
    editName: string;
    onEditId: (v: string) => void;
    onEditName: (v: string) => void;
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
    const contextBadge = serverModel ? formatContextLimit(serverModel.limit?.context) : null;
    const vision = serverModel ? modelSupportsImage(serverModel) : false;

    if (editing) {
        return (
            <div
                className={`flex items-center gap-1.5 px-2.5 py-2${first ? "" : " border-t"}`}
                style={first ? undefined : {borderColor: "var(--lum-neutral-hairline)"}}
            >
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
                    label={enabled ? t["Enabled"] : t["Disabled"]}
                    onChange={(next) => setModelDisabled(serverModel!.providerID, serverModel!.modelID, !next)}
                />
            )}
        </div>
    );
}
