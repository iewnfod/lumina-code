import {useEffect, useRef, useState, type ClipboardEvent} from "react";
import {ArrowUp, Bot, Brain, Cpu, FileText, Paperclip, Square, X} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {ComposerAttachment, OpencodeAgent, OpencodeModel, SessionModelRef} from "../../opencode/types.ts";
import PopoverMenu, {MenuItem, MenuLabel} from "../ui/PopoverMenu.tsx";
import ToolbarButton from "./ToolbarButton.tsx";
import DirectoryPicker from "./DirectoryPicker.tsx";
import {useI18n} from "../../hooks/i18n.tsx";

/** Hard cap per attachment — data URIs ride inside the prompt JSON. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Display labels for the thinking-depth variants a model can carry. */
const DEPTH_LABELS: Record<string, string> = {
    none: "Off",
    low: "Low",
    medium: "Medium",
    high: "High",
    max: "Max",
};

function depthLabel(variant: string): string {
    return DEPTH_LABELS[variant] ?? variant.charAt(0).toUpperCase() + variant.slice(1);
}

/** Read one file into a data-URI attachment (size-capped). */
function readAttachment(file: File): Promise<ComposerAttachment | null> {
    if (file.size > MAX_ATTACHMENT_BYTES) return Promise.resolve(null);
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
            resolve({
                id: `${file.name}:${file.size}:${file.lastModified}`,
                name: file.name,
                mime: file.type || "application/octet-stream",
                size: file.size,
                uri: String(reader.result ?? ""),
            });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}

/**
 * The prompt composer: auto-growing textarea (Enter sends, Shift+Enter adds
 * a newline) over a bottom toolbar — attachments + mode on the left; model,
 * thinking depth and send on the right. Until the conversation starts (on
 * the welcome screen or in a freshly created session) the left side also
 * carries the project picker.
 */
export default function ChatInput({
    colors,
    disabled,
    busy,
    onSend,
    onInterrupt,
    agents,
    models,
    agent,
    model,
    onAgentChange,
    onModelChange,
    conversationStarted,
    api,
    directory,
    onDirectoryChange,
}: {
    colors: SurfaceColors;
    /** No connection yet. */
    disabled: boolean;
    busy: boolean;
    onSend: (text: string, files: ComposerAttachment[]) => void;
    onInterrupt: () => void;
    /** Selectable modes (primary agents). */
    agents: OpencodeAgent[];
    models: OpencodeModel[];
    /** Effective selections (session-bound once a session exists). */
    agent: string;
    model: SessionModelRef | null;
    onAgentChange: (agent: string) => void;
    onModelChange: (model: SessionModelRef) => void;
    /** False until the conversation has its first message — shows the
     *  project picker (welcome screen and freshly created sessions). */
    conversationStarted: boolean;
    api: OpencodeApi | null;
    directory: string | null;
    onDirectoryChange: (directory: string | null) => void;
}) {
    const t = useI18n();
    const [text, setText] = useState("");
    const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // WebKitGTK (Tauri's webview on Linux) clears the native undo stack of
    // JS-controlled inputs, so Ctrl+Z does nothing. Keep our own history:
    // typing within COALESCE_MS collapses into one undo step.
    const COALESCE_MS = 400;
    const historyRef = useRef<{stack: string[]; index: number; lastAt: number}>({
        stack: [""],
        index: 0,
        lastAt: 0,
    });

    const recordHistory = (value: string) => {
        const h = historyRef.current;
        const now = Date.now();
        if (now - h.lastAt > COALESCE_MS) {
            h.stack = h.stack.slice(0, h.index + 1);
            h.stack.push(value);
            if (h.stack.length > 200) h.stack.shift();
            h.index = h.stack.length - 1;
        } else {
            h.stack[h.index] = value;
        }
        h.lastAt = now;
    };

    const undo = () => {
        const h = historyRef.current;
        if (h.index > 0) {
            h.index--;
            h.lastAt = 0;
            setText(h.stack[h.index]);
        }
    };

    const redo = () => {
        const h = historyRef.current;
        if (h.index < h.stack.length - 1) {
            h.index++;
            h.lastAt = 0;
            setText(h.stack[h.index]);
        }
    };

    // Auto-grow up to 5 lines, then scroll.
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "0px";
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || el.scrollHeight;
        el.style.height = Math.min(el.scrollHeight, Math.ceil(lineHeight * 5)) + "px";
    }, [text]);

    const addFiles = async (files: File[]) => {
        const staged = await Promise.all(files.map(readAttachment));
        const fresh = staged.filter((f): f is ComposerAttachment => f !== null);
        if (fresh.length === 0) return;
        setAttachments((prev) => {
            const held = new Set(prev.map((a) => a.id));
            return [...prev, ...fresh.filter((a) => !held.has(a.id))];
        });
    };

    const submit = () => {
        const trimmed = text.trim();
        if (!trimmed || disabled) return;
        onSend(trimmed, attachments);
        setText("");
        historyRef.current = {stack: [""], index: 0, lastAt: 0};
        setAttachments([]);
        textareaRef.current?.focus();
    };

    const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(e.clipboardData?.files ?? []);
        if (files.length > 0) {
            e.preventDefault();
            void addFiles(files);
        }
    };

    // Resolved catalog entries for the current selections.
    const currentModel = model
        ? models.find((m) => m.providerID === model.providerID && m.modelID === model.id) ?? null
        : null;
    const variants = currentModel?.variants ?? [];
    const currentVariant = model?.variant ?? variants[0]?.id;
    const agentName = agents.find((a) => a.id === agent)?.name ?? agent;

    // Group the catalog by provider for the model picker.
    const providerGroups: [string, OpencodeModel[]][] = [];
    for (const m of models) {
        const last = providerGroups[providerGroups.length - 1];
        if (last && last[0] === m.providerID) last[1].push(m);
        else providerGroups.push([m.providerID, [m]]);
    }

    /** Switching models keeps the current depth when the new model has it. */
    const pickModel = (m: OpencodeModel) => {
        const nextVariants = m.variants ?? [];
        const variant = nextVariants.some((v) => v.id === currentVariant)
            ? currentVariant
            : nextVariants[0]?.id;
        onModelChange({id: m.modelID, providerID: m.providerID, variant});
    };

    return (
        <div
            className="w-full flex flex-col rounded-[var(--radius-lg)] transition-shadow duration-[var(--duration-fast)]"
            style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
        >
            <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                    void addFiles(Array.from(e.target.files ?? []));
                    e.target.value = "";
                }}
            />

            {attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                    {attachments.map((a) => (
                        <span
                            key={a.id}
                            title={a.name}
                            className="inline-flex items-center gap-1.5 h-7 pl-1.5 pr-1 rounded-[var(--radius-sm)] max-w-64"
                            style={{background: colors.activeOverlay}}
                        >
                            {a.mime.startsWith("image/") ? (
                                <img src={a.uri} alt="" className="w-5 h-5 rounded-[var(--radius-xs)] object-cover shrink-0"/>
                            ) : (
                                <FileText size={13} className="shrink-0 opacity-60"/>
                            )}
                            <span className="text-xs truncate">{a.name}</span>
                            <button
                                type="button"
                                title={t["Remove attachment"]}
                                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                                className="inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-xs)] cursor-pointer hover:bg-[var(--lum-chip-hover)] transition-colors duration-[var(--duration-fast)]"
                                style={{"--lum-chip-hover": colors.hoverOverlay} as React.CSSProperties}
                            >
                                <X size={11}/>
                            </button>
                        </span>
                    ))}
                </div>
            )}

            <textarea
                ref={textareaRef}
                rows={1}
                value={text}
                disabled={disabled}
                placeholder={disabled ? t["Connecting to OpenCode…"] : "Message OpenCode…"}
                spellCheck={false}
                className="resize-none bg-transparent outline-none px-4 pt-3 pb-1.5 text-sm placeholder:opacity-40 disabled:opacity-50 max-h-[calc(1.25rem*5)]"
                onChange={(e) => {
                    const value = e.currentTarget.value;
                    setText(value);
                    recordHistory(value);
                }}
                onPaste={onPaste}
                onKeyDown={(e) => {
                    const mod = e.ctrlKey || e.metaKey;
                    if (mod && (e.key === "z" || e.key === "Z")) {
                        e.preventDefault();
                        if (e.shiftKey) redo();
                        else undo();
                        return;
                    }
                    if (mod && (e.key === "y" || e.key === "Y")) {
                        e.preventDefault();
                        redo();
                        return;
                    }
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        submit();
                    }
                }}
            />

            <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
                {/* Left: attachments, mode, and (pre-session) directory. */}
                <ToolbarButton
                    icon={<Paperclip size={14}/>}
                    colors={colors}
                    title={t["Add attachment"]}
                    disabled={disabled}
                    onClick={() => fileInputRef.current?.click()}
                />
                <PopoverMenu
                    colors={colors}
                    align="start"
                    title={t["Mode"]}
                    trigger={({open, toggle}) => (
                        <ToolbarButton
                            icon={<Bot size={14}/>}
                            label={agentName}
                            chevron
                            active={open}
                            colors={colors}
                            onClick={toggle}
                        />
                    )}
                >
                    {(close) => (
                        <div className="w-52">
                            <MenuLabel>{t["Mode"]}</MenuLabel>
                            {agents.map((a) => (
                                <div key={a.id} title={a.description}>
                                    <MenuItem
                                        colors={colors}
                                        selected={a.id === agent}
                                        onClick={() => {
                                            onAgentChange(a.id);
                                            close();
                                        }}
                                    >
                                        {a.name ?? a.id}
                                    </MenuItem>
                                </div>
                            ))}
                        </div>
                    )}
                </PopoverMenu>
                {!conversationStarted && (
                    <DirectoryPicker
                        api={api}
                        colors={colors}
                        directory={directory}
                        onChange={onDirectoryChange}
                    />
                )}

                <div className="flex-1"/>

                {/* Right: model, thinking depth, send/stop. */}
                <PopoverMenu
                    colors={colors}
                    align="end"
                    panelClassName="w-60"
                    title={t["Model"]}
                    trigger={({open, toggle}) => (
                        <ToolbarButton
                            icon={<Cpu size={14}/>}
                            label={currentModel?.name ?? model?.id ?? t["Model"]}
                            chevron
                            active={open}
                            colors={colors}
                            onClick={toggle}
                        />
                    )}
                >
                    {(close) => (
                        <div>
                            {providerGroups.map(([provider, group]) => (
                                <div key={provider}>
                                    <MenuLabel>{provider}</MenuLabel>
                                    {group.map((m) => (
                                        <MenuItem
                                            key={`${m.providerID}/${m.modelID}`}
                                            colors={colors}
                                            selected={model != null &&
                                                m.providerID === model.providerID && m.modelID === model.id}
                                            onClick={() => {
                                                pickModel(m);
                                                close();
                                            }}
                                        >
                                            {m.name ?? m.modelID}
                                        </MenuItem>
                                    ))}
                                </div>
                            ))}
                        </div>
                    )}
                </PopoverMenu>
                {variants.length > 0 && currentVariant !== undefined && (
                    <PopoverMenu
                        colors={colors}
                        align="end"
                        title={t["Thinking depth"]}
                        trigger={({open, toggle}) => (
                            <ToolbarButton
                                icon={<Brain size={14}/>}
                                label={depthLabel(currentVariant)}
                                chevron
                                active={open}
                                colors={colors}
                                onClick={toggle}
                            />
                        )}
                    >
                        {(close) => (
                            <div>
                                <MenuLabel>{t["Thinking depth"]}</MenuLabel>
                                {variants.map((v) => (
                                    <MenuItem
                                        key={v.id}
                                        colors={colors}
                                        selected={v.id === currentVariant}
                                        onClick={() => {
                                            if (model) onModelChange({...model, variant: v.id});
                                            close();
                                        }}
                                    >
                                        {depthLabel(v.id)}
                                    </MenuItem>
                                ))}
                            </div>
                        )}
                    </PopoverMenu>
                )}
                {busy ? (
                    <button
                        type="button"
                        title={t["Stop"]}
                        onClick={onInterrupt}
                        className="ml-1 inline-flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] cursor-pointer hover:bg-[rgba(128,128,128,0.2)] transition-colors duration-[var(--duration-fast)]"
                    >
                        <Square size={14}/>
                    </button>
                ) : (
                    <button
                        type="button"
                        title={t["Send"]}
                        onClick={submit}
                        disabled={disabled || !text.trim()}
                        className="ml-1 inline-flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-[var(--duration-fast)] disabled:opacity-35 disabled:cursor-not-allowed hover:bg-[rgba(128,128,128,0.2)]"
                    >
                        <ArrowUp size={16}/>
                    </button>
                )}
            </div>
        </div>
    );
}
