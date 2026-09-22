import {useCallback, useEffect, useRef, useState} from "react";
import {ArrowUp, Bot, Brain, Cpu, FileText, Paperclip, Square, X} from "lucide-react";
import {LexicalComposer} from "@lexical/react/LexicalComposer";
import {PlainTextPlugin} from "@lexical/react/LexicalPlainTextPlugin";
import {ContentEditable} from "@lexical/react/LexicalContentEditable";
import {HistoryPlugin} from "@lexical/react/LexicalHistoryPlugin";
import {OnChangePlugin} from "@lexical/react/LexicalOnChangePlugin";
import {LexicalErrorBoundary} from "@lexical/react/LexicalErrorBoundary";
import {useLexicalComposerContext} from "@lexical/react/LexicalComposerContext";
import {
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    $getSelection,
    $isElementNode,
    $isRangeSelection,
    $isTextNode,
    COMMAND_PRIORITY_HIGH,
    KEY_ENTER_COMMAND,
    KEY_ARROW_LEFT_COMMAND,
    KEY_ARROW_RIGHT_COMMAND,
    mergeRegister,
    type EditorState,
    type LexicalEditor,
    type LexicalNode,
} from "lexical";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {ComposerAttachment, ComposerFileRef, OpencodeAgent, OpencodeCommand, OpencodeModel, SessionModelRef} from "../../opencode/types.ts";
import PopoverMenu, {MenuItem, MenuLabel} from "../ui/PopoverMenu.tsx";
import ToolbarButton from "./ToolbarButton.tsx";
import DirectoryPicker from "./DirectoryPicker.tsx";
import InputSuggestions, {type SuggestionItem} from "./InputSuggestions.tsx";
import {$createFileMentionNode, $isFileMentionNode, FileMentionNode} from "./FileMentionNode.tsx";
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

/** What the composer is autocompleting right now: the trigger character's
 *  kind plus where the trigger starts in the text and the query typed
 *  since (up to the caret, with no whitespace — a space closes it). */
interface SuggestState {
    kind: "command" | "file";
    /** Character offset of the `/` or `@` in the serialized plain text. */
    start: number;
    query: string;
}

/** Detects an open trigger before the caret: `/` or `@` at the start of
 *  the text or right after whitespace, still unclosed (no space between
 *  it and the caret). Returns null when not autocompleting. */
function detectTrigger(value: string, caret: number): SuggestState | null {
    const m = value.slice(0, caret).match(/(?:^|\s)([\/@])(\S*)$/);
    if (!m) return null;
    return {kind: m[1] === "/" ? "command" : "file", start: caret - m[2].length - 1, query: m[2]};
}

/** One slash command to execute server-side instead of a plain prompt. */
export interface PendingCommand {
    name: string;
    arguments: string;
}

/** Atomic ←/→ across a file chip: when the caret sits inside a chip (the
 *  native caret can land in token text) or right next to one, land the
 *  selection on the FAR side of the whole chip in a single step. Returns
 *  whether it handled the key. */
function $skipFileMention(editor: LexicalEditor, direction: -1 | 1): boolean {
    const jump = editor.getEditorState().read((): -1 | 1 | null => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel) || !sel.isCollapsed()) return null;
        const anchor = sel.anchor;
        const node = anchor.getNode();
        if ($isFileMentionNode(node)) return direction;
        if ($isTextNode(node)) {
            if (direction === -1 && anchor.offset === 0) {
                return $isFileMentionNode(node.getPreviousSibling()) ? -1 : null;
            }
            if (direction === 1 && anchor.offset === node.getTextContentSize()) {
                return $isFileMentionNode(node.getNextSibling()) ? 1 : null;
            }
        }
        return null;
    });
    if (jump === null) return false;
    let handled = false;
    editor.update(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return;
        let node = sel.anchor.getNode();
        if (!$isFileMentionNode(node)) {
            const sibling = direction === -1 ? node.getPreviousSibling() : node.getNextSibling();
            if (!sibling || !$isFileMentionNode(sibling)) return;
            node = sibling;
        }
        if (direction === -1) node.selectPrevious();
        else node.selectNext();
        handled = true;
    });
    return handled;
}

/**
 * The prompt composer: a Lexical rich-text editor (Enter sends,
 * Shift+Enter adds a newline; `@file` mentions render as inline chips)
 * over a bottom toolbar — attachments + mode on the left; model, thinking
 * depth and send on the right. Until the conversation starts (on the
 * welcome screen or in a freshly created session) the left side also
 * carries the project picker. Typing `/` or `@` at word start opens an
 * inline autocomplete (commands / workspace files).
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
    onSend: (text: string, files: ComposerAttachment[], fileRefs: ComposerFileRef[], command: PendingCommand | null) => void;
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
    const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
    const [commands, setCommands] = useState<OpencodeCommand[]>([]);
    const commandsRef = useRef<{loaded: boolean; list: OpencodeCommand[]}>({loaded: false, list: []});
    const [canSend, setCanSend] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // Imperative handle into the editor (submit) — the send button lives
    // here in the toolbar, the editor state lives in ComposerCore.
    const composerApiRef = useRef<{submit: () => void} | null>(null);

    // Slash commands are a small static list — load once per connection so
    // both the autocomplete and submit-time parsing see them.
    useEffect(() => {
        if (!api || commandsRef.current.loaded) return;
        let cancelled = false;
        api.listCommands().then((list) => {
            if (cancelled) return;
            commandsRef.current = {loaded: true, list: list ?? []};
            setCommands(list ?? []);
        }).catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [api]);

    const addFiles = useCallback(async (files: File[]) => {
        const staged = await Promise.all(files.map(readAttachment));
        const fresh = staged.filter((f): f is ComposerAttachment => f !== null);
        if (fresh.length === 0) return;
        setAttachments((prev) => {
            const held = new Set(prev.map((a) => a.id));
            return [...prev, ...fresh.filter((a) => !held.has(a.id))];
        });
    }, []);

    /** ComposerCore hands the serialized content up; attachments ride
     *  along and are cleared with the editor. */
    const handleSubmit = useCallback((text: string, fileRefs: ComposerFileRef[], command: PendingCommand | null) => {
        onSend(text, attachments, fileRefs, command);
        setAttachments([]);
    }, [onSend, attachments]);

    const initialConfig = {
        namespace: "lumina-composer",
        nodes: [FileMentionNode],
        onError: (e: unknown) => console.error("[composer]", e),
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
            className="relative w-full flex flex-col rounded-[var(--radius-lg)] transition-shadow duration-[var(--duration-fast)]"
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

            <LexicalComposer initialConfig={initialConfig}>
                <ComposerCore
                    colors={colors}
                    disabled={disabled}
                    api={api}
                    directory={directory}
                    commands={commands}
                    placeholder={disabled ? t["Connecting to OpenCode…"] : "Message OpenCode…"}
                    addFiles={addFiles}
                    onSubmit={handleSubmit}
                    onReady={(handle) => {
                        composerApiRef.current = handle;
                    }}
                    onCanSendChange={setCanSend}
                />
            </LexicalComposer>

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
                        onClick={() => composerApiRef.current?.submit()}
                        disabled={disabled || !canSend}
                        className="ml-1 inline-flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-[var(--duration-fast)] disabled:opacity-35 disabled:cursor-not-allowed hover:bg-[rgba(128,128,128,0.2)]"
                    >
                        <ArrowUp size={16}/>
                    </button>
                )}
            </div>
        </div>
    );
}

/**
 * Everything editor-internal: trigger detection, suggestions, Enter to
 * send, paste-to-attach, auto-grow. Lives inside {@link LexicalComposer}
 * so it can reach the editor via context; the parent gets an imperative
 * `{submit}` handle for the toolbar's send button.
 */
function ComposerCore({
    colors,
    disabled,
    api,
    directory,
    commands,
    placeholder,
    addFiles,
    onSubmit,
    onReady,
    onCanSendChange,
}: {
    colors: SurfaceColors;
    disabled: boolean;
    api: OpencodeApi | null;
    directory: string | null;
    commands: OpencodeCommand[];
    placeholder: string;
    addFiles: (files: File[]) => Promise<void>;
    onSubmit: (text: string, fileRefs: ComposerFileRef[], command: PendingCommand | null) => void;
    onReady: (handle: {submit: () => void}) => void;
    onCanSendChange: (canSend: boolean) => void;
}) {
    const t = useI18n();
    const [editor] = useLexicalComposerContext();
    const [suggest, setSuggest] = useState<SuggestState | null>(null);
    const [suggestItems, setSuggestItems] = useState<SuggestionItem[]>([]);
    const [suggestSelected, setSuggestSelected] = useState(0);
    // Esc dismisses the popup for the current trigger; it stays closed until
    // the trigger disappears and a new one is typed (start identifies it).
    const dismissedStartRef = useRef<number | null>(null);
    // Latest render values for native-event / command callbacks that
    // register once but must read fresh state.
    const liveRef = useRef({suggest, items: suggestItems, selected: suggestSelected, disabled});
    liveRef.current = {suggest, items: suggestItems, selected: suggestSelected, disabled};
    const addFilesRef = useRef(addFiles);
    addFilesRef.current = addFiles;

    // Grab focus on mount: a freshly created session (or a session switch)
    // remounts the composer, and the user's next keystroke should land in it.
    useEffect(() => {
        if (!disabled) editor.focus();
    }, [editor, disabled]);

    // Serialize to plain text (mention → "@relative", blocks joined by
    // newlines) and map the caret into that string — the same coordinates
    // detectTrigger works in. File mentions are token text ("@relative")
    // and map into the string like any text — no special casing needed.
    //
    // --- Layout decoupled from the editor's internal DOM ---
    // The text area's height comes from a hidden MIRROR that renders the
    // serialized text with identical metrics. The mirror never has focus,
    // so it is immune to WebKitGTK's empty-editable quirks (line boxes
    // materializing on click, carets not painting) — whatever the editable
    // does internally, the outer layout holds still. The editable itself
    // is absolutely positioned to fill the measured box.
    const mirrorRef = useRef<HTMLDivElement>(null);
    const [boxHeight, setBoxHeight] = useState<number>(38);

    const measure = useCallback((text: string) => {
        const mirror = mirrorRef.current;
        const root = editor.getRootElement();
        if (!mirror || !root) return;
        mirror.textContent = text;
        const cs = getComputedStyle(mirror);
        const lineHeight = parseFloat(cs.lineHeight) || 20;
        const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 0;
        const lines = Math.max(1, Math.round((mirror.scrollHeight - pad) / lineHeight));
        setBoxHeight(Math.min(lines, 5) * lineHeight + pad);
        // Scroll only once the content is capped at 5 lines — WebKit has a
        // history of not painting carets inside always-scrollable edit roots.
        root.style.overflowY = lines > 5 ? "auto" : "hidden";
    }, [editor]);

    useEffect(() => {
        measure("");
    }, [measure]);

    const onChange = useCallback((state: EditorState) => {
        let serialized = "";
        state.read(() => {
            let text = "";
            let caret: number | null = null;
            const sel = $getSelection();
            const isRange = $isRangeSelection(sel);
            const anchorNode: LexicalNode | null = isRange ? sel.anchor.getNode() : null;
            const anchorOffset = isRange ? sel.anchor.offset : 0;
            $getRoot().getChildren().forEach((block, bi) => {
                if (bi > 0) text += "\n";
                for (const child of $isElementNode(block) ? block.getChildren() : []) {
                    // File mentions are token TextNodes ("@relative") — they
                    // map into the string like any text, so the caret math
                    // below needs no special case. LineBreakNodes (the
                    // Shift+Enter kind) contribute "\n" via getTextContent.
                    if ($isTextNode(child)) {
                        const content = child.getTextContent();
                        if (child === anchorNode) caret = text.length + Math.min(anchorOffset, content.length);
                        text += content;
                    } else {
                        text += child.getTextContent();
                    }
                }
            });
            onCanSendChange(text.trim().length > 0);
            const next = caret === null ? null : detectTrigger(text, caret);
            if (!next) {
                dismissedStartRef.current = null;
                setSuggest(null);
                setSuggestItems([]);
            } else if (dismissedStartRef.current !== next.start) {
                setSuggest(next);
                setSuggestSelected(0);
            }
            serialized = text;
        });
        measure(serialized);
    }, [editor, onCanSendChange, measure]);

    // Commands filter client-side (small list); files come from the
    // server's fuzzy finder, debounced.
    useEffect(() => {
        if (!suggest) return;
        if (suggest.kind === "command") {
            const q = suggest.query.toLowerCase();
            setSuggestItems(
                commands
                    .filter((c) => c.name.toLowerCase().includes(q))
                    .slice(0, 50)
                    .map((c) => ({kind: "command" as const, command: c})),
            );
            return;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
            api?.findFiles(suggest.query, directory)
                .then((files) => {
                    if (cancelled) return;
                    setSuggestItems(files.slice(0, 50).map((f) => ({kind: "file" as const, file: f})));
                })
                .catch(() => {
                    if (!cancelled) setSuggestItems([]);
                });
        }, 150);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [suggest, commands, api, directory]);

    // Clamp the highlight when the item list shrinks underneath it.
    useEffect(() => {
        setSuggestSelected((i) => Math.min(i, Math.max(0, suggestItems.length - 1)));
    }, [suggestItems]);

    /** Replace the active trigger (+query) with the picked item — a
     *  command becomes text, a file becomes an inline mention chip. */
    const accept = useCallback((item: SuggestionItem) => {
        editor.update(() => {
            const sel = $getSelection();
            if (!$isRangeSelection(sel)) return;
            const node = sel.anchor.getNode();
            const off = sel.anchor.offset;
            if (item.kind === "command") {
                const insert = `/${item.command.name} `;
                if ($isTextNode(node)) {
                    const content = node.getTextContent();
                    const m = content.slice(0, off).match(/(?:^|\s)\/(\S*)$/);
                    if (m) {
                        const start = off - m[1].length - 1;
                        node.setTextContent(content.slice(0, start) + insert + content.slice(off));
                        node.select(start + insert.length);
                        return;
                    }
                }
                sel.insertText(insert);
                return;
            }
            const mention = $createFileMentionNode(item.file);
            const space = $createTextNode(" ");
            if ($isTextNode(node)) {
                const content = node.getTextContent();
                const m = content.slice(0, off).match(/(?:^|\s)@(\S*)$/);
                if (m) {
                    const start = off - m[1].length - 1;
                    const after = content.slice(off);
                    node.setTextContent(content.slice(0, start));
                    node.insertAfter(mention);
                    mention.insertAfter(space);
                    if (after) space.insertAfter($createTextNode(after));
                    space.select(1);
                    return;
                }
            }
            sel.insertNodes([mention, space]);
            space.select(1);
        });
        dismissedStartRef.current = null;
        setSuggest(null);
        setSuggestItems([]);
    }, [editor]);

    const submit = useCallback(() => {
        if (liveRef.current.disabled) return;
        const payload = editor.getEditorState().read(() => {
            let text = "";
            const paths: string[] = [];
            $getRoot().getChildren().forEach((block, bi) => {
                if (bi > 0) text += "\n";
                for (const child of $isElementNode(block) ? block.getChildren() : []) {
                    if ($isFileMentionNode(child)) {
                        paths.push(child.getAbsolute());
                    }
                    // LineBreakNodes (Shift+Enter) contribute "\n"; mentions
                    // contribute "@relative" — both via getTextContent.
                    text += child.getTextContent();
                }
            });            return {text, paths};
        });
        const trimmed = payload.text.trim();
        if (!trimmed) return;
        // A leading /name that matches a known command runs server-side;
        // anything else (including unknown /words) goes as a plain prompt.
        let command: PendingCommand | null = null;
        const slash = trimmed.match(/^\/(\S+)\s*([\s\S]*)$/);
        if (slash && commands.some((c) => c.name === slash[1])) {
            command = {name: slash[1], arguments: slash[2] ?? ""};
        }
        onSubmit(trimmed, payload.paths.map((path) => ({path})), command);
        editor.update(() => {
            $getRoot().clear();
            $getRoot().append($createParagraphNode());
        });
        editor.focus();
    }, [editor, commands, onSubmit]);

    // Hand the imperative submit up to the toolbar's send button.
    useEffect(() => {
        onReady({submit});
    }, [onReady, submit]);

    // Enter sends (or accepts a suggestion); Shift+Enter inserts a newline.
    // IME-confirm Enters are left alone.
    useEffect(
        () =>
            editor.registerCommand(
                KEY_ENTER_COMMAND,
                (payload: KeyboardEvent | null) => {
                    if (!payload || payload.isComposing) return false;
                    const live = liveRef.current;
                    if (live.suggest && live.items.length > 0) {
                        payload.preventDefault();
                        accept(live.items[Math.min(live.selected, live.items.length - 1)] ?? live.items[0]);
                        return true;
                    }
                    if (!payload.shiftKey) {
                        payload.preventDefault();
                        submit();
                        return true;
                    }
                    return false;
                },
                COMMAND_PRIORITY_HIGH,
            ),
        [editor, accept, submit],
    );

    // File chips are atomic: ←/→ jump over the WHOLE chip instead of
    // walking its characters. The native caret can land inside token text
    // (WebKit moves within the DOM text node), so intercept at the
    // boundary AND when already inside, and re-land the selection on the
    // far side of the mention.
    useEffect(
        () =>
            mergeRegister(
                editor.registerCommand(
                    KEY_ARROW_LEFT_COMMAND,
                    (event) => {
                        if ($skipFileMention(editor, -1)) {
                            event?.preventDefault();
                            return true;
                        }
                        return false;
                    },
                    COMMAND_PRIORITY_HIGH,
                ),
                editor.registerCommand(
                    KEY_ARROW_RIGHT_COMMAND,
                    (event) => {
                        if ($skipFileMention(editor, 1)) {
                            event?.preventDefault();
                            return true;
                        }
                        return false;
                    },
                    COMMAND_PRIORITY_HIGH,
                ),
            ),
        [editor],
    );

    // Suggestion navigation on the raw element (capture, so arrows move
    // the highlight instead of the caret while the popup is open).
    useEffect(() => {
        const el = editor.getRootElement();
        if (!el) return;
        const onKey = (e: KeyboardEvent) => {
            const live = liveRef.current;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                if (live.suggest && live.items.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    const delta = e.key === "ArrowDown" ? 1 : -1;
                    setSuggestSelected((i) => (i + delta + live.items.length) % live.items.length);
                }
                return;
            }
            if (e.key === "Escape" && live.suggest) {
                e.preventDefault();
                e.stopPropagation();
                dismissedStartRef.current = live.suggest.start;
                setSuggest(null);
                setSuggestItems([]);
            }
        };
        el.addEventListener("keydown", onKey, true);
        return () => el.removeEventListener("keydown", onKey, true);
    }, [editor]);

    // Paste with files in the clipboard → attachments, not editor content.
    useEffect(() => {
        const el = editor.getRootElement();
        if (!el) return;
        const onPaste = (e: ClipboardEvent) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length > 0) {
                e.preventDefault();
                void addFilesRef.current(files);
            }
        };
        el.addEventListener("paste", onPaste);
        return () => el.removeEventListener("paste", onPaste);
    }, [editor]);

    return (
        <div className="relative w-full" style={{height: boxHeight}}>
            {suggest && (
                <InputSuggestions
                    colors={colors}
                    items={suggestItems}
                    selected={suggestSelected}
                    emptyLabel={suggest.kind === "command" ? t["No matching commands"] : t["No matching files"]}
                    onSelect={(item) => accept(item)}
                />
            )}
            {/* Hidden mirror: same metrics as the editable, never focused —
                the single source of truth for the text area's height. */}
            <div
                ref={mirrorRef}
                aria-hidden
                className="absolute left-0 right-0 top-0 invisible pointer-events-none px-4 pt-3 pb-1.5 text-sm whitespace-pre-wrap break-words"
            />
            <PlainTextPlugin
                contentEditable={
                    <ContentEditable
                        className={`absolute inset-0 resize-none bg-transparent outline-none px-4 pt-3 pb-1.5 text-sm whitespace-pre-wrap break-words ${disabled ? "opacity-50" : ""}`}
                        readOnly={disabled}
                        ariaLabel="Message OpenCode"
                    />
                }
                placeholder={
                    <div className="absolute top-0 left-0 px-4 pt-3 text-sm pointer-events-none opacity-40 select-none">
                        {placeholder}
                    </div>
                }
                ErrorBoundary={LexicalErrorBoundary}
            />
            <HistoryPlugin/>
            <OnChangePlugin ignoreSelectionChange={false} onChange={onChange}/>
        </div>
    );
}
