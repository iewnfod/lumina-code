import {useEffect, useState} from "react";
import {info, warn as logWarn, error as logError} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "../../opencode/api.ts";
import {globalConfigTarget} from "../../opencode/configFiles.ts";
import {
    luminaToolsPluginPath,
    readLuminaToolsOptions,
    withSystemPrompt,
} from "../../opencode/toolPluginConfig.ts";
import {ensureLuminaToolsPlugin} from "../../opencode/useLuminaTools.ts";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import Button from "../ui/Button.tsx";
import TextArea from "./TextArea.tsx";
import SectionHeader from "./SectionHeader.tsx";

/**
 * The custom system prompt section (General pane) — a paragraph the user
 * writes once and every model call reads: stored as the PLUGIN-LEVEL
 * `systemPrompt` option of our lumina-tools plugin entry in the global
 * opencode.json (the same home as the vision model, written through the
 * shared installer ensureLuminaToolsPlugin — the server hot-reloads, so
 * the next model call already carries it), and pushed by the plugin's
 * context hook AFTER everything the server itself assembled (built-in
 * prompt + AGENTS.md / instructions). Applies to every OpenCode session
 * on this machine (the plugin is global), except Lumina's restricted
 * helper agents. Empty = off.
 *
 * Unlike the pane's module-store rows, the source of truth is the SERVER
 * config: mount loads it (the pane mounts only while active, so mount is
 * the open), the Save button writes it, and both the JSONC-config and
 * read-failure states degrade to the manual-edit notice — the same
 * contract as the Model pane's config editors. Split from
 * GeneralSettings.tsx (a server-config editor among instant-apply rows).
 */
export default function SystemPromptSection({api}: {api: OpencodeApi | null}) {
    const colors = useColors();
    const t = useI18n();
    /** The value persisted on the server (always trimmed); null while
     *  unknown (loading) or when editing is impossible (jsonc/failed) —
     *  Save stays disabled in those states. */
    const [saved, setSaved] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    /** The global config can't be machine-edited (JSONC file or unparseable
     *  text) — read-only notice instead of the editor. */
    const [locked, setLocked] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [savedFlash, setSavedFlash] = useState(false);

    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        api.listConfigEntries().then((entries) => {
            const target = globalConfigTarget(entries ?? []);
            if (!target) {
                if (!cancelled) setLoadFailed(true);
                return;
            }
            if (target.jsonc) {
                if (!cancelled) setLocked(true);
                return;
            }
            const name = target.file.split("/").pop() ?? "opencode.json";
            api.readTextFile(target.directory, name).then((text) => {
                if (cancelled) return;
                // null (absent) and "" (empty file) both mean "nothing
                // configured yet"; a null parse means JSONC/garbage — the
                // installer would refuse the write, so degrade to locked.
                const options = text === null || text === "" ? {} : readLuminaToolsOptions(text, luminaToolsPluginPath(target.directory));
                if (options === null) {
                    setLocked(true);
                    return;
                }
                setSaved(options.systemPrompt?.trim() ?? "");
                setDraft(options.systemPrompt?.trim() ?? "");
            }).catch((e) => {
                if (cancelled) return;
                setLoadFailed(true);
                logError(`Failed to read global config for the system prompt: ${e}`).catch(() => {});
            });
        }).catch((e) => {
            if (cancelled) return;
            setLoadFailed(true);
            logError(`Failed to discover config location for the system prompt: ${e}`).catch(() => {});
        });
        return () => {
            cancelled = true;
        };
    }, [api]);

    // The saved flash fades on its own; unmount (pane close) cancels it.
    useEffect(() => {
        if (!savedFlash) return;
        const timer = setTimeout(() => setSavedFlash(false), 2000);
        return () => clearTimeout(timer);
    }, [savedFlash]);

    /** Save through the shared installer. The config is RE-READ fresh so
     * the merge starts from what is actually stored (a vision-model choice
     * saved in the Model pane meanwhile survives — the installer's options
     * argument replaces the stored options wholesale). */
    const save = () => {
        if (!api || busy || saved === null) return;
        setBusy(true);
        api.listConfigEntries().then((entries) => {
            const target = globalConfigTarget(entries ?? []);
            if (!target) throw new Error("no-config-target");
            const name = target.file.split("/").pop() ?? "opencode.json";
            return api.readTextFile(target.directory, name).then((text) => {
                const current = text === null || text === "" ? {} : readLuminaToolsOptions(text, luminaToolsPluginPath(target.directory));
                if (current === null) throw new Error("invalid-config");
                return ensureLuminaToolsPlugin(api, withSystemPrompt(current, draft));
            });
        }).then((result) => {
            if (result.status === "skipped") {
                setActionError(`${t["Save failed"]}: ${result.reason}`);
                logWarn(`system-prompt save skipped: ${result.reason}`).catch(() => {});
                return;
            }
            setSaved(draft.trim());
            setActionError(null);
            setSavedFlash(true);
            info("Saved custom system prompt via the lumina-tools plugin").catch(() => {});
        }).catch((e) => {
            setActionError(`${t["Save failed"]}: ${e}`);
            logError(`Failed to save custom system prompt: ${e}`).catch(() => {});
        }).finally(() => {
            setBusy(false);
        });
    };

    if (locked || loadFailed) {
        // Both degrade to the same shape: the header + one quiet notice
        // (manual-edit hint for JSONC, plain failure otherwise).
        return (
            <div className="flex flex-col gap-4">
                <SectionHeader label={t["Custom system prompt"]}/>
                <p className="text-xs leading-relaxed" style={{color: colors.inactiveText}}>
                    {locked
                        ? t["The config file uses JSONC (comments) and cannot be edited here. Open it to edit manually."]
                        : t["Failed to load config"]}
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <SectionHeader label={t["Custom system prompt"]}/>
            <TextArea
                value={draft}
                placeholder={t["Additional instructions for the model…"]}
                disabled={busy}
                onChange={setDraft}
            />
            <div className="flex items-center justify-between gap-3">
                {actionError ? (
                    <p className="text-xs leading-relaxed min-w-0"
                        style={{color: "var(--color-brand-cinnabar-soft)"}}>
                        {actionError}
                    </p>
                ) : (
                    <p className="text-xs leading-relaxed opacity-55">
                        {t["Appended after OpenCode's built-in system prompt, for every session on this machine. Leave empty to disable."]}
                    </p>
                )}
                <div className="flex items-center gap-2 shrink-0">
                    {savedFlash && <span className="text-xs opacity-55">{t["Saved"]}</span>}
                    <Button
                        primary
                        label={t["Save"]}
                        disabled={busy || saved === null || draft.trim() === saved}
                        onClick={save}
                    />
                </div>
            </div>
        </div>
    );
}
