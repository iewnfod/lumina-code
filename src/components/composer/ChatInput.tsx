import {memo, useCallback, useEffect, useRef, useState} from "react";
import {Pencil, X} from "lucide-react";
import {LexicalComposer} from "@lexical/react/LexicalComposer";
import {error} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import {useConnection} from "../../opencode/connectionContext.tsx";
import type {
    ChatUserMessage,
    ComposerAttachment,
    ComposerFileRef,
    OpencodeCommand,
    PendingCommand,
    SessionModelRef,
    SessionUsage,
} from "../../opencode/types.ts";
import type {ContextUsage} from "../chat/usageStats.ts";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import {splitAttachmentNote} from "../../opencode/visionAttachments.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import ComposerCore, {type ComposerHandle} from "./ComposerCore.tsx";
import ComposerToolbar from "./ComposerToolbar.tsx";
import {filesFromMessage, readAttachment} from "./composerAttachments.ts";
import {saveDraftAttachments, saveDraftEditorState, takeInitialDraft} from "./composerDrafts.ts";
import {FileMentionNode} from "./FileMentionNode.tsx";
import {CommandMentionNode} from "./CommandMentionNode.tsx";
import Hint from "../ui/Hint.tsx";

/**
 * The prompt composer shell: staged attachments (chips above the editor),
 * the Lexical editor itself (ComposerCore — trigger detection, suggestions,
 * keyboard routing, submit serialization) and the bottom toolbar
 * (ComposerToolbar — attachments/mode/project on the left; usage ring,
 * model, thinking depth, send on the right).
 *
 * Enter sends, Shift+Enter adds a newline; `@file` mentions render as
 * inline text with a file-type icon; typing `/` or `@` at word start opens
 * an inline autocomplete (commands / workspace files). Until the
 * conversation starts (welcome screen or a freshly created session) the
 * toolbar also carries the project picker.
 *
 * Memoized: the parent ChatView re-renders on every streaming frame (the
 * transcript grows per rAF), and none of that concerns the composer.
 * With memo + stable callbacks from ChatView (onSend/onInterrupt are
 * useCallback'd there; every other prop is state or a primitive from App),
 * the whole editor subtree — Lexical, pickers, the catalog grouping —
 * skips re-rendering while tokens stream.
 */
const ChatInput = memo(function ChatInput({
    disabled,
    busy,
    onSend,
    onInterrupt,
    agent,
    model,
    onAgentChange,
    onModelChange,
    conversationStarted,
    directory,
    onDirectoryChange,
    onOpenModelConfig,
    usage = null,
    contextUsage = null,
    /** Draft-store key for this surface (session id, or the welcome
     *  screen's fixed key) — keeps the half-typed buffer across the
     *  surface-swap remounts. */
    draftKey,
    draftLoad = null,
    onDraftLoaded,
    editMessage = null,
    onCancelEdit,
    onSubmitEdit,
}: {
    /** No connection yet. */
    disabled: boolean;
    busy: boolean;
    onSend: (text: string, files: ComposerAttachment[], fileRefs: ComposerFileRef[], command: PendingCommand | null) => void;
    onInterrupt: () => void;
    /** Effective selections (session-bound once a session exists). */
    agent: string;
    model: SessionModelRef | null;
    onAgentChange: (agent: string) => void;
    onModelChange: (model: SessionModelRef) => void;
    /** False until the conversation has its first message — shows the
     *  project picker (welcome screen and freshly created sessions). */
    conversationStarted: boolean;
    directory: string | null;
    onDirectoryChange: (directory: string | null) => void;
    /** Opens the settings modal on its Model tab (model/provider config). */
    onOpenModelConfig: () => void;
    /** Session cumulative usage — tooltip reference lines only. */
    usage?: SessionUsage | null;
    /** The session's current context reading (last measured step). */
    contextUsage?: ContextUsage | null;
    draftKey: string;
    /** A queued-prompt row's "edit": its text + attachments load back
     * into the composer (replacing the buffer) and the entry leaves the
     * queue. `token` makes each request a distinct load even when the
     * same row is edited twice. Applied only in NORMAL mode — ChatView
     * locks the row's pencil while an edit-last-message session is
     * active so the two buffers never clobber each other. */
    draftLoad?: {token: number; text: string; files: ComposerAttachment[]} | null;
    /** Fires once a draftLoad has been applied (ChatView clears it). */
    onDraftLoaded?: () => void;
    /** The sent message being edited HERE (null = normal send mode —
     *  the welcome screen passes none). Entering edit loads its text +
     *  attachments into the composer; the draft in progress is stashed
     *  and restored when the edit ends without a successful submit. */
    editMessage?: ChatUserMessage | null;
    onCancelEdit?: () => void;
    /** Submit the edit; resolves false when the revert failed (the
     *  composer keeps the edited text and attachments for a retry). */
    onSubmitEdit?: (message: ChatUserMessage, text: string, files: ComposerAttachment[]) => Promise<boolean>;
}) {
    const colors = useColors();
    const t = useI18n();
    // Server handle from the connection context (slash commands); the
    // picker catalog is ComposerToolbar's own concern now.
    const {api} = useConnection();
    // Draft restore: staged attachments come back with the editor state
    // (both were saved into the draft store on every change); a submit
    // clears the entry, so a fresh mount after sending starts empty.
    const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => takeInitialDraft(draftKey)?.attachments ?? []);
    // Mirror staged attachments into the draft store (the editor half is
    // ComposerCore's concern — it owns the EditorState).
    useEffect(() => {
        saveDraftAttachments(draftKey, attachments);
    }, [draftKey, attachments]);
    const [commands, setCommands] = useState<OpencodeCommand[]>([]);
    // The list last fetched, keyed by its directory — remounts for the
    // same directory reuse it, a directory change re-queries.
    const commandsRef = useRef<{directory: string | null; list: OpencodeCommand[]} | null>(null);
    const [canSend, setCanSend] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // Imperative handle into the editor (submit, edit-mode entry) — the
    // send button lives in the toolbar, the editor state lives in
    // ComposerCore.
    const composerApiRef = useRef<ComposerHandle | null>(null);

    // --- Edit mode ("edit last message" lives in the composer) ---
    // Entering: stash whatever draft was in progress (snapshot object —
    // the store never mutates entries in place), load the message's
    // plain text + its attachments as removable chips. Leaving without a
    // successful submit (cancel): restore the stash full-fidelity
    // (mention nodes survive). A successful submit consumes the stash in
    // handleSubmit, so this restore is a no-op and the composer is
    // already empty. Unmounting mid-edit (session switch) writes the
    // stash back into the draft store — the pre-edit buffer survives the
    // surface swap.
    const stashRef = useRef<{editorState: string; attachments: ComposerAttachment[]} | null>(null);
    useEffect(() => {
        if (editMessage) {
            stashRef.current = takeInitialDraft(draftKey) ?? {editorState: "", attachments: []};
            // The vision-divert note is protocol, not the user's words —
            // edit the clean prompt; editResend re-appends the note from
            // the ORIGINAL message so the model keeps its image paths.
            composerApiRef.current?.setText(splitAttachmentNote(editMessage.text).text);
            setAttachments(filesFromMessage(editMessage));
            return () => {
                const pending = stashRef.current;
                if (pending) {
                    saveDraftEditorState(draftKey, pending.editorState);
                    saveDraftAttachments(draftKey, pending.attachments);
                }
            };
        }
        const stash = stashRef.current;
        if (stash) {
            stashRef.current = null;
            if (stash.editorState) {
                composerApiRef.current?.setState(stash.editorState);
            } else {
                composerApiRef.current?.setState("");
            }
            setAttachments(stash.attachments);
        }
    }, [editMessage, draftKey]);

    // A queued row's "edit" arriving from above: load its text +
    // attachments into the composer, replacing whatever draft was staged
    // (resubmitting re-enqueues while the session runs). The callback
    // rides a ref so a per-render-identical ChatView callback never
    // re-triggers the load.
    const onDraftLoadedRef = useRef(onDraftLoaded);
    onDraftLoadedRef.current = onDraftLoaded;
    useEffect(() => {
        if (editMessage || !draftLoad) return;
        composerApiRef.current?.setText(draftLoad.text);
        setAttachments(draftLoad.files);
        onDraftLoadedRef.current?.();
    }, [draftLoad, editMessage]);

    // Slash commands are a small list, but they are location-scoped
    // (project-local .opencode/commands/ + built-ins only register inside
    // a project) — fetch per directory so the autocomplete and
    // submit-time parsing both see the directory's real command set.
    // The server loads a never-seen location lazily: the FIRST response
    // for a cold directory comes back empty and settles within a few
    // seconds, so empty results are retried a bounded number of times
    // and only non-empty lists short-circuit via the cache.
    useEffect(() => {
        if (!api) return;
        const cached = commandsRef.current;
        if (cached && cached.directory === directory && cached.list.length > 0) {
            setCommands(cached.list);
            return;
        }
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let retries = 0;
        const run = () => {
            api.listCommands(directory).then((list) => {
                if (cancelled) return;
                const next = list ?? [];
                commandsRef.current = {directory, list: next};
                setCommands(next);
                if (next.length === 0 && retries < 3) {
                    retries += 1;
                    timer = setTimeout(run, 1000 * retries);
                }
            }).catch((e) => {
                error(`Failed to list commands: ${e}`).catch(() => {});
            });
        };
        run();
        return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
        };
    }, [api, directory]);

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
     *  along and are cleared with the editor. In edit mode the content
     *  routes to the edit-submit instead (revert + resend); a failed
     *  revert resolves false, which keeps the whole buffer in place. */
    const handleSubmit = useCallback(
        (
            text: string,
            fileRefs: ComposerFileRef[],
            command: PendingCommand | null,
        ): boolean | Promise<boolean> => {
            if (editMessage) {
                if (!onSubmitEdit) return false;
                const files = attachments;
                return onSubmitEdit(editMessage, text, files).then((ok) => {
                    if (ok) {
                        // The edit replaced the message — the stashed
                        // pre-edit draft is dead and the composer rests
                        // empty (ComposerCore clears the editor).
                        stashRef.current = null;
                        setAttachments([]);
                    }
                    return ok;
                });
            }
            onSend(text, attachments, fileRefs, command);
            setAttachments([]);
            return true;
        },
        [editMessage, onSubmitEdit, onSend, attachments],
    );

    const initialConfig = {
        namespace: "lumina-composer",
        nodes: [FileMentionNode, CommandMentionNode],
        // Restored draft (if any): the serialized EditorState re-hydrates
        // text AND mention nodes (the node set is registered above). NOTE:
        // the config field is `editorState` (Lexical's InitialConfigType)
        // — an `initialEditorState` key would be silently ignored, and
        // this object has no type annotation to catch it.
        editorState: takeInitialDraft(draftKey)?.editorState || undefined,
        onError: (e: unknown) => {
            error(`Composer error: ${e}`).catch(() => {});
        },
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

            {editMessage && (
                /* The edit-mode banner: names the mode and offers the
                 * cancel (the bubble being edited wears a highlight ring
                 * so the target stays visible while typing down here). */
                <div className="flex items-center gap-2 px-3 pt-2.5 text-xs" style={{color: colors.inactiveText}}>
                    <Pencil size={12} className="shrink-0"/>
                    <span className="select-none">{t["Editing message"]}</span>
                    <span className="flex-1"/>
                    <Hint label={t["Cancel"]}>
                        <button
                            type="button"
                            onClick={onCancelEdit}
                            className="inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-xs)] cursor-pointer hover:bg-[var(--lum-chip-hover)] transition-colors duration-[var(--duration-fast)]"
                            style={{"--lum-chip-hover": colors.hoverOverlay} as React.CSSProperties}
                        >
                            <X size={11}/>
                        </button>
                    </Hint>
                </div>
            )}

            {attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                    {attachments.map((a) => (
                        <span
                            key={a.id}
                            className="inline-flex items-center gap-1.5 h-7 pl-1.5 pr-1 rounded-[var(--radius-sm)] max-w-64"
                            style={{background: colors.activeOverlay}}
                        >
                            {a.mime.startsWith("image/") ? (
                                <img src={a.uri} alt="" className="w-5 h-5 rounded-[var(--radius-xs)] object-cover shrink-0"/>
                            ) : (
                                <img src={fileIconUrl(a.name)} alt="" className="w-4 h-4 shrink-0"/>
                            )}
                            <span className="text-xs truncate">{a.name}</span>
                            <Hint label={t["Remove attachment"]}>
                                <button
                                    type="button"
                                    onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                                    className="inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-xs)] cursor-pointer hover:bg-[var(--lum-chip-hover)] transition-colors duration-[var(--duration-fast)]"
                                    style={{"--lum-chip-hover": colors.hoverOverlay} as React.CSSProperties}
                                >
                                    <X size={11}/>
                                </button>
                            </Hint>
                        </span>
                    ))}
                </div>
            )}

            <LexicalComposer initialConfig={initialConfig}>
                <ComposerCore
                    disabled={disabled}
                    draftKey={draftKey}
                    directory={directory}
                    commands={commands}
                    placeholder={
                        disabled
                            ? t["Connecting to OpenCode..."]
                            : busy
                                ? t["Keep typing to queue messages"]
                                : t["Ask Lumina Code, use @ to add context, use / for commands"]
                    }
                    addFiles={addFiles}
                    onSubmit={handleSubmit}
                    onReady={(handle) => {
                        composerApiRef.current = handle;
                    }}
                    onCanSendChange={setCanSend}
                    onCancelEdit={editMessage ? onCancelEdit : undefined}
                />
            </LexicalComposer>

            <ComposerToolbar
                disabled={disabled}
                busy={busy}
                canSend={canSend}
                onAttach={() => fileInputRef.current?.click()}
                onSend={() => composerApiRef.current?.submit()}
                onInterrupt={onInterrupt}
                agent={agent}
                model={model}
                onAgentChange={onAgentChange}
                onModelChange={onModelChange}
                conversationStarted={conversationStarted}
                directory={directory}
                onDirectoryChange={onDirectoryChange}
                onOpenModelConfig={onOpenModelConfig}
                usage={usage}
                contextUsage={contextUsage}
            />
        </div>
    );
});

export default ChatInput;
