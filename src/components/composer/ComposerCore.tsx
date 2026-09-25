import {useCallback, useEffect, useRef, useState} from "react";
import {PlainTextPlugin} from "@lexical/react/LexicalPlainTextPlugin";
import {ContentEditable} from "@lexical/react/LexicalContentEditable";
import {HistoryPlugin} from "@lexical/react/LexicalHistoryPlugin";
import {OnChangePlugin} from "@lexical/react/LexicalOnChangePlugin";
import {LexicalErrorBoundary} from "@lexical/react/LexicalErrorBoundary";
import {useLexicalComposerContext} from "@lexical/react/LexicalComposerContext";
import {
    $createParagraphNode,
    $createTextNode,
    $getNodeByKey,
    $getRoot,
    $isElementNode,
    $isTextNode,
    COMMAND_PRIORITY_HIGH,
    KEY_ARROW_DOWN_COMMAND,
    KEY_ARROW_LEFT_COMMAND,
    KEY_ARROW_RIGHT_COMMAND,
    KEY_ARROW_UP_COMMAND,
    KEY_ENTER_COMMAND,
    KEY_ESCAPE_COMMAND,
    KEY_TAB_COMMAND,
    mergeRegister,
    type EditorState,
} from "lexical";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {isMacOS} from "../../lib/platform.ts";
import {clearDraft, saveDraftEditorState} from "./composerDrafts.ts";
import type {
    ComposerFileRef,
    OpencodeCommand,
    PendingCommand,
} from "../../opencode/types.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import InputSuggestions, {type SuggestionItem} from "./InputSuggestions.tsx";
import {$createFileMentionNode, $isFileMentionNode} from "./FileMentionNode.tsx";
import {$createCommandMentionNode} from "./CommandMentionNode.tsx";
import {$detectTrigger, $skipMention, triggerId, type TriggerState} from "./composerTriggers.ts";

/** Editable metrics (must stay in lockstep with the ContentEditable's
 *  classes): one text line = 20px, vertical padding = 12 + 6, growth
 *  capped at 5 lines. */
const LINE_HEIGHT = 20;
const MAX_LINES = 5;

/**
 * Everything editor-internal: trigger detection, suggestions, keyboard
 * routing, Enter to send, paste-to-attach. Lives inside the LexicalComposer
 * (see ChatInput) so it can reach the editor via context; the parent gets
 * an imperative `{submit}` handle for the toolbar's send button.
 *
 * All keyboard interaction goes through Lexical commands (Enter, arrows,
 * Tab, Escape) with IME-composition guards, and the editable itself grows
 * in normal flow via CSS min/max height — no measured mirror, no manual
 * caret-to-string math. The trigger/detection helpers live in
 * composerTriggers.ts.
 */
export default function ComposerCore({
    disabled,
    busy,
    draftKey,
    directory,
    commands,
    placeholder,
    addFiles,
    onSubmit,
    onReady,
    onCanSendChange,
}: {
    disabled: boolean;
    busy: boolean;
    /** Draft-store key (see ChatInput) — the editor half of the draft. */
    draftKey: string;
    directory: string | null;
    commands: OpencodeCommand[];
    placeholder: string;
    addFiles: (files: File[]) => Promise<void>;
    onSubmit: (text: string, files: ComposerFileRef[], command: PendingCommand | null) => void;
    onReady: (handle: {submit: () => void}) => void;
    onCanSendChange: (canSend: boolean) => void;
}) {
    const t = useI18n();
    // Server handle from the connection context (file suggestions).
    const {api} = useConnection();
    const [editor] = useLexicalComposerContext();
    const [suggest, setSuggest] = useState<TriggerState | null>(null);
    const [suggestItems, setSuggestItems] = useState<SuggestionItem[]>([]);
    const [suggestSelected, setSuggestSelected] = useState(0);
    // Esc dismisses the popup for the current trigger; it stays closed
    // until the trigger disappears and a new one is typed (nodeKey+offset
    // identifies it — editing elsewhere doesn't lift the dismissal).
    const dismissedRef = useRef<string | null>(null);
    // Latest render values for command callbacks that register once but
    // must read fresh state.
    const liveRef = useRef({suggest, items: suggestItems, selected: suggestSelected, disabled, busy});
    liveRef.current = {suggest, items: suggestItems, selected: suggestSelected, disabled, busy};
    const addFilesRef = useRef(addFiles);
    addFilesRef.current = addFiles;

    // Grab focus on mount: a freshly created session (or a session switch)
    // remounts the composer, and the user's next keystroke should land in it.
    // A restored draft must also recompute canSend (onChange only fires on
    // CHANGES, and the initialEditorState hydration is not one).
    useEffect(() => {
        if (!disabled) editor.focus();
        onCanSendChange(editor.getEditorState().read(() => $getRoot().getTextContent().trim().length > 0));
    }, [editor, disabled, onCanSendChange]);

    // Selection changes count (caret moves re-run trigger detection);
    // content changes recompute canSend and the open trigger — all read
    // from the node tree, never from a serialized string. Content changes
    // also persist the buffer into the draft store (selection-only
    // callbacks are skipped via state identity).
    const lastDraftStateRef = useRef<EditorState | null>(null);
    const onChange = useCallback(
        (state: EditorState) => {
            if (state !== lastDraftStateRef.current) {
                lastDraftStateRef.current = state;
                saveDraftEditorState(draftKey, JSON.stringify(state.toJSON()));
            }
            state.read(() => {
                onCanSendChange($getRoot().getTextContent().trim().length > 0);
                const next = $detectTrigger();
                if (!next) {
                    dismissedRef.current = null;
                    setSuggest(null);
                    setSuggestItems([]);
                } else if (dismissedRef.current !== triggerId(next)) {
                    setSuggest(next);
                    setSuggestSelected(0);
                }
            });
        },
        [onCanSendChange, draftKey],
    );

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

    /**
     * Replace the detected trigger (+query) with the picked item — a
     * command becomes plain text, a file becomes an inline mention. Both
     * splice the exact text node the trigger was detected in (looked up by
     * key), verified against the trigger character still being there, so a
     * stale detection can never corrupt the buffer.
     */
    const accept = useCallback(
        (item: SuggestionItem) => {
            const trig = liveRef.current.suggest;
            if (trig) {
                editor.update(() => {
                    const node = $getNodeByKey(trig.nodeKey);
                    if (!$isTextNode(node) || $isFileMentionNode(node)) return;
                    const content = node.getTextContent();
                    const triggerChar = trig.kind === "command" ? "/" : "@";
                    if (content[trig.offset] !== triggerChar) return; // stale
                    const before = content.slice(0, trig.offset);
                    const after = content.slice(trig.offset + 1 + trig.query.length);
                    if (item.kind === "command") {
                        // Command: atomic `/name` mention + a trailing
                        // space to type arguments into — mirrors the file
                        // mention below (token node, whole-word delete,
                        // serializes back to `/name` on submit).
                        const mention = $createCommandMentionNode({name: item.command.name});
                        const space = $createTextNode(" ");
                        node.setTextContent(before);
                        node.insertAfter(mention);
                        mention.insertAfter(space);
                        if (after) space.insertAfter($createTextNode(after));
                        space.select(1);
                        return;
                    }
                    // File: mention + a trailing space to land the caret in.
                    const mention = $createFileMentionNode(item.file);
                    const space = $createTextNode(" ");
                    node.setTextContent(before);
                    node.insertAfter(mention);
                    mention.insertAfter(space);
                    if (after) space.insertAfter($createTextNode(after));
                    space.select(1);
                });
            }
            dismissedRef.current = null;
            setSuggest(null);
            setSuggestItems([]);
            setSuggestSelected(0);
        },
        [editor],
    );

    /** Serialize the buffer for sending: plain text (mentions contribute
     *  "@relative", blocks joined by newlines) + the absolute paths of all
     *  mentions. Enter with a non-empty buffer sends; a leading `/name`
     *  that matches a known command runs server-side instead. */
    const submit = useCallback(() => {
        const live = liveRef.current;
        if (live.disabled || live.busy) return;
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
            });
            return {text, paths};
        });
        const trimmed = payload.text.trim();
        if (!trimmed) return;
        let command: PendingCommand | null = null;
        const slash = trimmed.match(/^\/(\S+)\s*([\s\S]*)$/);
        if (slash && commands.some((c) => c.name === slash[1])) {
            command = {name: slash[1], arguments: slash[2] ?? ""};
        }
        onSubmit(trimmed, payload.paths.map((path) => ({path})), command);
        // Sent: drop the whole draft (editor state + attachments) for
        // this surface BEFORE clearing the editor — the clearing update
        // re-fires onChange and re-saves an empty buffer, which is the
        // correct resting draft anyway.
        clearDraft(draftKey);
        editor.update(() => {
            $getRoot().clear();
            $getRoot().append($createParagraphNode());
        });
        editor.focus();
    }, [editor, commands, onSubmit, draftKey]);

    // Hand the imperative submit up to the toolbar's send button.
    useEffect(() => {
        onReady({submit});
    }, [onReady, submit]);

    // --- Keyboard: one registration, Lexical commands only. -------------
    // Every handler is IME-safe: keys pressed while composing (candidate
    // navigation, confirm) are left to the input method.
    useEffect(() => {
        const openPopup = () => {
            const live = liveRef.current;
            return live.suggest && live.items.length > 0 ? live : null;
        };
        const highlighted = (live: {items: SuggestionItem[]; selected: number}) =>
            live.items[Math.min(live.selected, live.items.length - 1)] ?? live.items[0];
        return mergeRegister(
            // Enter accepts an open suggestion, otherwise sends;
            // Shift+Enter falls through to a newline.
            editor.registerCommand(
                KEY_ENTER_COMMAND,
                (payload: KeyboardEvent | null) => {
                    if (!payload || payload.isComposing || (isMacOS() && payload.keyCode === 229)) return false;
                    const live = openPopup();
                    if (live) {
                        payload.preventDefault();
                        accept(highlighted(live));
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
            // ↑/↓ move the popup highlight (not the caret) while open.
            editor.registerCommand(
                KEY_ARROW_UP_COMMAND,
                (event) => navigate(event, -1),
                COMMAND_PRIORITY_HIGH,
            ),
            editor.registerCommand(
                KEY_ARROW_DOWN_COMMAND,
                (event) => navigate(event, 1),
                COMMAND_PRIORITY_HIGH,
            ),
            // Tab accepts the highlighted suggestion while open.
            editor.registerCommand(
                KEY_TAB_COMMAND,
                (event) => {
                    if (!event || event.isComposing) return false;
                    const live = openPopup();
                    if (!live) return false;
                    event.preventDefault();
                    accept(highlighted(live));
                    return true;
                },
                COMMAND_PRIORITY_HIGH,
            ),
            // Esc closes the popup for THIS trigger only.
            editor.registerCommand(
                KEY_ESCAPE_COMMAND,
                (event) => {
                    const live = liveRef.current;
                    if (!live.suggest) return false;
                    event?.preventDefault();
                    dismissedRef.current = triggerId(live.suggest);
                    setSuggest(null);
                    setSuggestItems([]);
                    return true;
                },
                COMMAND_PRIORITY_HIGH,
            ),
            // Mentions are atomic: ←/→ jump over the WHOLE mention instead
            // of walking its characters (the native caret can land inside
            // token text on WebKit).
            editor.registerCommand(
                KEY_ARROW_LEFT_COMMAND,
                (event) => {
                    if ($skipMention(editor, -1)) {
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
                    if ($skipMention(editor, 1)) {
                        event?.preventDefault();
                        return true;
                    }
                    return false;
                },
                COMMAND_PRIORITY_HIGH,
            ),
        );
        function navigate(event: KeyboardEvent | null, delta: 1 | -1): boolean {
            if (!event || event.isComposing) return false;
            const live = openPopup();
            if (!live) return false;
            event.preventDefault();
            setSuggestSelected((i) => (i + delta + live.items.length) % live.items.length);
            return true;
        }
    }, [editor, accept, submit]);

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
        <div className="relative w-full">
            {suggest && (
                <InputSuggestions
                    items={suggestItems}
                    selected={suggestSelected}
                    emptyLabel={suggest.kind === "command" ? t["No matching commands"] : t["No matching files"]}
                    onSelect={(item) => accept(item)}
                />
            )}
            <PlainTextPlugin
                contentEditable={
                    <ContentEditable
                        // In-flow sizing: min one line (38px = 20px line +
                        // 12/6px padding), grow to MAX_LINES, scroll past
                        // that. CSS owns the geometry — nothing measures
                        // the text from JS.
                        className={`block w-full resize-none bg-transparent outline-none px-4 pt-3 pb-1.5 text-sm leading-5 whitespace-pre-wrap break-words overflow-y-auto min-h-[38px] ${disabled ? "opacity-50" : ""}`}
                        style={{maxHeight: MAX_LINES * LINE_HEIGHT + 18}}
                        readOnly={disabled}
                        spellCheck={false}
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
