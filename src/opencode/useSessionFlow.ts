import {useCallback, useEffect, useMemo, useState} from "react";
import {error} from "@tauri-apps/plugin-log";
import {loadState, saveState} from "../lib/persist.ts";
import {OpencodeApi} from "./api.ts";
import {prepareCommandSubmission} from "./useSessionMessages.ts";
import {useSessions} from "./useSessions.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {
    ComposerAttachment,
    ComposerFileRef,
    OpencodeAgent,
    OpencodeModel,
    PendingCommand,
    SessionModelRef,
} from "./types.ts";

/**
 * The app's session flow, extracted from App.tsx: which session is open,
 * what the composer is staged to use before one exists, and how a first
 * send creates the session (there is no empty-session view — see App).
 *
 * Once a session exists, its model/agent drive the composer and changes
 * hit the switch endpoints (optimistically patched into the sidebar
 * list). Before that, pending* state rides along into the session created
 * on the first send — including the working directory — seeded from the
 * last run's choices via lib/persist.ts.
 */
export function useSessionFlow(
    api: OpencodeApi | null,
    subscribe: (handler: OpencodeEventHandler) => () => void,
    catalog: {
        models: OpencodeModel[];
        agents: OpencodeAgent[];
        defaultModel: OpencodeModel | null;
    },
): {
    sessions: ReturnType<typeof useSessions>["sessions"];
    /** True once the first session list has landed. */
    sessionsLoaded: boolean;
    busyIds: ReadonlySet<string>;
    activeId: string | null;
    setActiveId: (id: string | null) => void;
    activeSession: ReturnType<typeof useSessions>["sessions"][number] | null;
    /** Composer selections: the session's own once it exists, else the
     *  staged/fallback pick. */
    effectiveModel: SessionModelRef | null;
    effectiveAgent: string;
    /** The welcome screen's staged project directory. */
    pendingDirectory: string | null;
    changeModel: (ref: SessionModelRef) => void;
    changeAgent: (id: string) => void;
    /** Back to the welcome screen (optionally staging a directory). */
    newSession: (directory?: string) => void;
    changeDirectory: (directory: string | null) => void;
    /** First send from the welcome screen: create the session, apply the
     *  staged model/agent, deliver the prompt (or run a slash command). */
    sendFirst: (
        text: string,
        files: ComposerAttachment[],
        fileRefs: ComposerFileRef[],
        command: PendingCommand | null,
    ) => Promise<void>;
    deleteSession: (id: string) => void;
} {
    const {models, agents, defaultModel} = catalog;
    const {sessions, loaded: sessionsLoaded, busyIds, create, remove, patch} = useSessions(api, subscribe);

    // Cross-restart restore, read synchronously so the first paint already
    // targets the previous session / composer choices.
    const restored = useMemo(loadState, []);
    const [activeId, setActiveId] = useState<string | null>(restored.sessionId);
    const activeSession = sessions.find((s) => s.id === activeId) ?? null;

    // --- Composer selections (staged pre-session) ---
    const [pendingModel, setPendingModel] = useState<SessionModelRef | null>(restored.model);
    const [pendingAgent, setPendingAgent] = useState<string | null>(restored.agent);
    const [pendingDirectory, setPendingDirectory] = useState<string | null>(restored.directory);

    // Preselect the server's default model when it survived the catalog
    // filter; otherwise the first (newest-first) own model. None until the
    // catalog loads.
    const fallbackModel = useMemo(() => {
        const inCatalog = defaultModel
            ? models.some(
                (m) => m.providerID === defaultModel.providerID && m.modelID === defaultModel.modelID,
            )
            : false;
        const chosen = inCatalog ? defaultModel : models[0];
        return chosen
            ? {id: chosen.modelID, providerID: chosen.providerID, variant: chosen.variants?.[0]?.id}
            : null;
    }, [defaultModel, models]);
    // A restored/staged pick only applies while the catalog still offers it —
    // the provider or agent may be gone since the last run.
    const stagedModel = useMemo(() => {
        if (!pendingModel) return null;
        if (models.length === 0) return pendingModel; // catalog still loading
        return models.some(
            (m) => m.providerID === pendingModel.providerID && m.modelID === pendingModel.id,
        ) ? pendingModel : null;
    }, [pendingModel, models]);
    const stagedAgent = useMemo(() => {
        if (!pendingAgent) return null;
        if (agents.length === 0) return pendingAgent; // catalog still loading
        return agents.some((a) => a.id === pendingAgent) ? pendingAgent : null;
    }, [pendingAgent, agents]);
    const effectiveModel = activeSession?.model ?? stagedModel ?? fallbackModel;
    const effectiveAgent = activeSession?.agent ?? stagedAgent ?? agents[0]?.id ?? "build";

    const changeModel = useCallback((ref: SessionModelRef) => {
        if (activeId) {
            patch(activeId, {model: ref});
            api?.switchModel(activeId, ref).catch((e) => {
                error(`Failed to switch model: ${e}`).catch(() => {});
            });
        } else {
            setPendingModel(ref);
        }
    }, [activeId, api, patch]);

    const changeAgent = useCallback((id: string) => {
        if (activeId) {
            patch(activeId, {agent: id});
            api?.switchAgent(activeId, id).catch((e) => {
                error(`Failed to switch agent: ${e}`).catch(() => {});
            });
        } else {
            setPendingAgent(id);
        }
    }, [activeId, api, patch]);

    /** "New session" = back to the welcome screen (there is no empty-session
     *  view; the session is created on the first send, see sendFirst).
     *  Without an explicit folder (the sidebar-top button) the project
     *  defaults to the previous session's — the active session's directory,
     *  or the most recently updated one; already composing on the welcome
     *  screen keeps the user's in-progress choice untouched. */
    const newSession = useCallback((directory?: string) => {
        if (directory !== undefined) {
            setPendingDirectory(directory);
        } else if (activeId !== null) {
            const previous = activeSession ?? sessions[0];
            setPendingDirectory(previous?.directory ?? previous?.location?.directory ?? null);
        }
        setActiveId(null);
    }, [activeId, activeSession, sessions]);

    /** The composer's project changed. There is no empty-session view —
     *  the session is created on the first send — so pre-session this just
     *  stages the choice; inside a conversation-less session (the picker
     *  only shows before the first message) drop the empty session and
     *  return to the welcome screen with the choice staged — nothing to
     *  lose before the first message, and moving it server-side would
     *  keep an empty session open. */
    const changeDirectory = useCallback((directory: string | null) => {
        if (!activeId) {
            setPendingDirectory(directory);
            return;
        }
        void remove(activeId);
        setPendingDirectory(directory);
        setActiveId(null);
    }, [activeId, remove]);

    /** First send from the welcome screen: create the session (in the chosen
     *  directory), apply the staged model/agent, then deliver the prompt
     *  (or run a slash command server-side). */
    const sendFirst = useCallback(async (
        text: string,
        files: ComposerAttachment[],
        fileRefs: ComposerFileRef[] = [],
        command: PendingCommand | null = null,
    ) => {
        if (!api) return;
        const created = await create(pendingDirectory ?? undefined);
        if (!created) return;
        if (pendingModel) {
            await api.switchModel(created.id, pendingModel).catch((e) => {
                error(`Failed to switch model: ${e}`).catch(() => {});
            });
        }
        if (pendingAgent) {
            await api.switchAgent(created.id, pendingAgent).catch((e) => {
                error(`Failed to switch agent: ${e}`).catch(() => {});
            });
        }
        setActiveId(created.id);
        const promptFiles = [
            ...files.map((f) => ({uri: f.uri, name: f.name})),
            ...fileRefs.map((r) => OpencodeApi.fileRefToPromptFile(r)),
        ];
        // Stamp the compact form BEFORE the request: the server enqueues
        // (and emits the confirming event) before the response arrives,
        // and the brand-new session needs its store entry anyway so the
        // event bus keeps the frame.
        const undoPending = command ? prepareCommandSubmission(created.id, command) : null;
        // A rejected slash command must not strand the freshly created
        // session with nothing in it — deliver the raw text as a plain
        // prompt so the model can interpret it instead.
        const deliver = (async () => {
            if (!command) return api.sendPrompt(created.id, text, promptFiles);
            try {
                await api.runSessionCommand(created.id, command.name, command.arguments);
            } catch (e) {
                error(`Command ${command.name} failed, sending as prompt: ${e}`).catch(() => {});
                undoPending?.(); // the fallback is a plain prompt now
                await api.sendPrompt(created.id, text, promptFiles);
            }
        })();
        await deliver.catch((e) => {
            error(`Failed to send prompt: ${e}`).catch(() => {});
        });
    }, [api, create, pendingAgent, pendingDirectory, pendingModel]);

    const deleteSession = useCallback((id: string) => {
        void remove(id);
        setActiveId((cur) => (cur === id ? null : cur));
    }, [remove]);

    // Drop a restored session id the server no longer lists (deleted while we
    // were away), once the first session list has actually landed.
    useEffect(() => {
        if (sessionsLoaded && activeId && !sessions.some((s) => s.id === activeId)) {
            setActiveId(null);
        }
    }, [sessionsLoaded, sessions, activeId]);

    // Persist what a restart should land on: the open session (or the welcome
    // screen's staged project), plus the model / thinking depth / mode in use.
    useEffect(() => {
        saveState({
            sessionId: activeId,
            model: effectiveModel,
            agent: effectiveAgent,
            directory: pendingDirectory,
        });
    }, [activeId, effectiveModel, effectiveAgent, pendingDirectory]);

    return {
        sessions,
        sessionsLoaded,
        busyIds,
        activeId,
        setActiveId,
        activeSession,
        effectiveModel,
        effectiveAgent,
        pendingDirectory,
        changeModel,
        changeAgent,
        newSession,
        changeDirectory,
        sendFirst,
        deleteSession,
    };
}
