import {useState} from "react";
import {motion} from "framer-motion";
import {Trash2} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {whileHoverTap} from "../../lib/motion.ts";
import Button from "../ui/Button.tsx";
import Hint from "../ui/Hint.tsx";
import TextInput from "./TextInput.tsx";
import type {CustomProviderDef} from "./modelConfig.ts";
import {Field} from "./modelSettingsChrome.tsx";

/** The add/edit form for one custom provider. */
export default function CustomProviderForm({
    def,
    isNew,
    onCancel,
    onSave,
}: {
    def: CustomProviderDef;
    isNew: boolean;
    onCancel: () => void;
    onSave: (def: CustomProviderDef) => void;
}) {
    const colors = useColors();
    const t = useI18n();
    const [draft, setDraft] = useState<CustomProviderDef>(def);

    const set = (patch: Partial<CustomProviderDef>) => setDraft((prev) => ({...prev, ...patch}));
    const setModel = (index: number, patch: Partial<{id: string; name: string}>) => {
        setDraft((prev) => ({
            ...prev,
            models: prev.models.map((m, i) => (i === index ? {...m, ...patch} : m)),
        }));
    };

    return (
        <div className="flex flex-col gap-3">
            <span className="text-sm font-semibold">{isNew ? t["Add custom provider"] : t["Edit custom provider"]}</span>

            <Field label={t["Provider ID"]}>
                <TextInput

                    value={draft.id}
                    disabled={!isNew}
                    placeholder="my-provider"
                    onChange={(id) => set({id})}
                />
            </Field>
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
                    placeholder="http://127.0.0.1:11434/v1"
                    onChange={(baseURL) => set({baseURL})}
                />
            </Field>
            <Field label={t["Package"]}>
                <TextInput

                    value={draft.npm}
                    onChange={(npm) => set({npm})}
                />
            </Field>

            <Field label={t["Models"]}>
                <div className="flex flex-col gap-1.5">
                    {draft.models.map((m, index) => (
                        <div key={index} className="flex items-center gap-1.5">
                            <TextInput

                                value={m.id}
                                placeholder={t["Model ID"]}
                                onChange={(id) => setModel(index, {id})}
                            />
                            <TextInput

                                value={m.name ?? ""}
                                placeholder={t["Model name"]}
                                onChange={(name) => setModel(index, {name})}
                            />
                            <Hint label={t["Remove"]} className="shrink-0">
                                <motion.button
                                    type="button"
                                    disabled={draft.models.length <= 1}
                                    onClick={() => setDraft((prev) => ({...prev, models: prev.models.filter((_, i) => i !== index)}))}
                                    {...whileHoverTap}
                                    className="inline-flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-model-remove)] disabled:opacity-30 disabled:cursor-not-allowed"
                                    style={{"--lum-model-remove": colors.hoverOverlay} as React.CSSProperties}
                                >
                                    <Trash2 size={13}/>
                                </motion.button>
                            </Hint>
                        </div>
                    ))}
                    <div>
                        <Button
                            label={t["Add model"]}

                            onClick={() => setDraft((prev) => ({...prev, models: [...prev.models, {id: "", name: ""}]}))}
                        />
                    </div>
                </div>
            </Field>

            <div className="flex items-center gap-2 pt-1">
                <Button label={t["Save"]} primary onClick={() => onSave(draft)}/>
                <Button label={t["Cancel"]} onClick={onCancel}/>
            </div>
        </div>
    );
}
