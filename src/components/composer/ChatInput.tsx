import {memo, useCallback, useEffect, useRef, useState} from "react";
import {X} from "lucide-react";
import {LexicalComposer} from "@lexical/react/LexicalComposer";
import {error} from "@tauri-apps/plugin-log";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {
    ComposerAttachment,
    ComposerFileRef,
    OpencodeAgent,
    OpencodeCommand,
    OpencodeModel,
    PendingCommand,
    SessionModelRef,
    SessionUsage,
} from "../../opencode/types.ts";
import type {ContextUsage} from "../chat/usageStats.ts";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import ComposerCore from "./ComposerCore.tsx";
import ComposerToolbar from "./ComposerToolbar.tsx";
import {readAttachment} from "./composerAttachments.ts";
import {FileMentionNode} from "./FileMentionNode.tsx";
import {CommandMentionNode} from "./CommandMentionNode.tsx";

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
    usage = null,
    contextUsage = null,
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
    /** Session cumulative usage — tooltip reference lines only. */
    usage?: SessionUsage | null;
    /** The session's current context reading (last measured step). */
    contextUsage?: ContextUsage | null;
}) {
    const t = useI18n();
    const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
    const [commands, setCommands] = useState<OpencodeCommand[]>([]);
    // The list last fetched, keyed by its directory — remounts for the
    // same directory reuse it, a directory change re-queries.
    const commandsRef = useRef<{directory: string | null; list: OpencodeCommand[]} | null>(null);
    const [canSend, setCanSend] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // Imperative handle into the editor (submit) — the send button lives
    // in the toolbar, the editor state lives in ComposerCore.
    const composerApiRef = useRef<{submit: () => void} | null>(null);

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
     *  along and are cleared with the editor. */
    const handleSubmit = useCallback((text: string, fileRefs: ComposerFileRef[], command: PendingCommand | null) => {
        onSend(text, attachments, fileRefs, command);
        setAttachments([]);
    }, [onSend, attachments]);

    const initialConfig = {
        namespace: "lumina-composer",
        nodes: [FileMentionNode, CommandMentionNode],
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
                                <img src={fileIconUrl(a.name)} alt="" className="w-4 h-4 shrink-0"/>
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
                    busy={busy}
                    api={api}
                    directory={directory}
                    commands={commands}
                    placeholder={disabled ? t["Connecting to OpenCode…"] : t["Ask Lumina Code, use @ to add context, use / for commands"]}
                    addFiles={addFiles}
                    onSubmit={handleSubmit}
                    onReady={(handle) => {
                        composerApiRef.current = handle;
                    }}
                    onCanSendChange={setCanSend}
                />
            </LexicalComposer>

            <ComposerToolbar
                colors={colors}
                disabled={disabled}
                busy={busy}
                canSend={canSend}
                onAttach={() => fileInputRef.current?.click()}
                onSend={() => composerApiRef.current?.submit()}
                onInterrupt={onInterrupt}
                agents={agents}
                models={models}
                agent={agent}
                model={model}
                onAgentChange={onAgentChange}
                onModelChange={onModelChange}
                conversationStarted={conversationStarted}
                api={api}
                directory={directory}
                onDirectoryChange={onDirectoryChange}
                usage={usage}
                contextUsage={contextUsage}
            />
        </div>
    );
});

export default ChatInput;
