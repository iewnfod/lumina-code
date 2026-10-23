import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {error, info, warn} from "@tauri-apps/plugin-log";
import {loadState, saveState} from "../lib/persist.ts";
import {fileRefToPromptFile, OpencodeApi} from "./api.ts";
import {type AppMode, sessionMode, useAppMode} from "./appMode.ts";
import {ensureDefaultWorkspace, resolveDefaultWorkspace, resolveSessionDirectory} from "./defaultWorkspace.ts";
import {appendFailedPrompt, prepareCommandSubmission} from "./useSessionMessages.ts";
import {useCatalog} from "./catalogContext.tsx";
import {useConnection} from "./connectionContext.tsx";
import {useSessionData} from "./sessionDataContext.tsx";
import {divertAttachmentsForSend, modelAcceptsImages} from "./visionAttachments.ts";
import {mainDirFor, projectIdForDirectory, recordWorktree} from "./worktreeSessions.ts";
import type {
    ComposerAttachment,
    ComposerFileRef,
    OpencodeSession,
    PendingCommand,
    SessionModelRef,
} from "./types.ts";

/** Resolve the directory a branch-bound first send should create its
 *  session in: a server-managed linked WORKTREE pinned at the branch
 *  (recorded in worktreeSessions so the chip/labels know its branch).
 *  Never throws — every failure falls back to the MAIN worktree with a
 *  log (the send proceeds, honestly on the repo's own checkout; the
 *  title bar shows the main directory's real branch). */
async function resolveBranchDirectory(
    api: OpencodeApi,
    mainDir: string,
    branch: string,
): Promise<string> {
    let projects = null;
    try {
        projects = await api.listProjects();
    } catch (e) {
        warn(`Project list failed, branch "${branch}" falls back to the main worktree: ${e}`).catch(() => {});
        return mainDir;
    }
    const projectID = projectIdForDirectory(projects, mainDir);
    if (!projectID) {
        warn(`No registered git project for ${mainDir}, branch "${branch}" falls back to the main worktree`).catch(() => {});
        return mainDir;
    }
    try {
        const {directory} = await api.createWorktree({projectID, branch});
        recordWorktree(directory, {branch, mainDir});
        info(`Branch worktree for "${branch}": ${directory}`).catch(() => {});
        return directory;
    } catch (e) {
        error(`Worktree creation for branch "${branch}" failed, using the main worktree: ${e}`).catch(() => {});
        return mainDir;
    }
}

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
 *
 * Consumes the context split (connection / catalog / session data):
 * the session list + CRUD live in SessionDataProvider, the catalog in
 * CatalogProvider; this hook is pure flow control on top of them.
 */
export function useSessionFlow(): {
    sessions: OpencodeSession[];
    /** True once the first session list has landed. */
    sessionsLoaded: boolean;
    busyIds: ReadonlySet<string>;
    activeId: string | null;
    setActiveId: (id: string | null) => void;
    activeSession: OpencodeSession | null;
    /** Composer selections: the session's own once it exists, else the
     *  staged/fallback pick. */
    effectiveModel: SessionModelRef | null;
    effectiveAgent: string;
    /** The welcome screen's staged project directory. */
    pendingDirectory: string | null;
    /** The welcome screen's staged branch binding (null = main worktree). */
    pendingBranch: string | null;
    changeModel: (ref: SessionModelRef) => void;
    changeAgent: (id: string) => void;
    /** Stage the next session's branch binding (pre-session only). */
    changeStagedBranch: (branch: string | null) => void;
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
    /** DEV + welcome screen + no project staged: the composer's send
     *  is refused until a directory is picked (dev has no default). */
    sendBlocked: boolean;
} {
    const {api} = useConnection();
    const {models, agents, defaultModel} = useCatalog();
    const {
        sessions,
        sessionsLoaded,
        busyIds,
        createSession: create,
        removeSession: remove,
        patchSession: patch,
    } = useSessionData();
    // The DAILY/DEV split (opencode/appMode.ts): sendFirst's directory
    // rules and the mode stamp follow the EFFECTIVE mode (a confirmed
    // git-less machine forces "daily" — see the gate there).
    const mode = useAppMode();

    // Cross-restart restore, read synchronously so the first paint already
    // targets the previous session / composer choices.
    const restored = useMemo(loadState, []);
    const [activeId, setActiveId] = useState<string | null>(restored.sessionId);
    const activeSession = sessions.find((s) => s.id === activeId) ?? null;
    // What each mode had open when it was last left (null = that mode was
    // on the welcome screen) — switching back restores it. Seeded from the
    // persisted ui-state so the memory survives restarts; the CURRENT
    // mode's entry tracks activeId through the sync effect below (the
    // mode-switch effect only writes the mode being LEFT).
    const modeSessionsRef = useRef<Record<AppMode, string | null>>({
        daily: restored.dailySessionId,
        dev: restored.devSessionId,
    });

    // --- Composer selections (staged pre-session) ---
    const [pendingModel, setPendingModel] = useState<SessionModelRef | null>(restored.model);
    const [pendingAgent, setPendingAgent] = useState<string | null>(restored.agent);
    const [pendingDirectory, setPendingDirectory] = useState<string | null>(restored.directory);
    // Staged branch binding for the session the first send will create
    // (null = the project's main worktree). Deliberately NOT persisted:
    // a branch is staged per composition, and a restart landing on the
    // welcome screen starts a fresh choice (the same reasoning as the
    // in-progress draft staying in memory).
    const [pendingBranch, setPendingBranch] = useState<string | null>(null);

    // --- Mode-switch choreography (appMode.ts) ---
    // Switching halves (or being forced off dev by a confirmed git-less
    // machine) remembers what the LEFT mode had open, clears the staging
    // (the previous session's directory belongs to the old mode too — a
    // daily workspace must not leak into dev's picker, so unlike
    // newSession() nothing is re-seeded) and RESTORES the new mode's own
    // last session: each half reopens where the user left it, instead of
    // always landing on the welcome screen. The restore only takes a
    // session that still exists, still belongs to that mode and the list
    // has loaded — anything else (deleted meanwhile, welcome screen when
    // the mode was left, early boot) is the welcome screen, where the dev
    // preselect effect below stages a directory as usual.
    const prevModeRef = useRef(mode);
    useEffect(() => {
        if (prevModeRef.current === mode) return;
        const prevMode = prevModeRef.current;
        prevModeRef.current = mode;
        // What the LEFT mode had open — activeId is still that mode's
        // value in this render (the restore below only takes effect on
        // the next one). null records the welcome screen just as
        // faithfully.
        modeSessionsRef.current[prevMode] = activeId;
        setPendingBranch(null);
        setPendingDirectory(null);
        // Already sitting on a session of the NEW mode (a session opened
        // in one half never navigates in the other, but be safe): keep it.
        if (activeId !== null && activeSession && sessionMode(activeSession) === mode) return;
        const remembered = modeSessionsRef.current[mode];
        const restoredSession = remembered !== null && sessionsLoaded
            ? sessions.find((s) => s.id === remembered && sessionMode(s) === mode) ?? null
            : null;
        setActiveId(restoredSession ? remembered : null);
    }, [mode, activeId, activeSession, sessions, sessionsLoaded]);
    // Keep the CURRENT mode's memory in lockstep with every activeId
    // change (user open/new/delete/edit-resend…). The ownership guard is
    // the point: on the mode-switch render activeId still belongs to the
    // OLD mode, and an unguarded write would pollute the new mode's
    // entry with the old half's session until the restore re-render
    // overwrites it.
    useEffect(() => {
        if (activeId === null || (activeSession && sessionMode(activeSession) === mode)) {
            modeSessionsRef.current[mode] = activeId;
        }
    }, [mode, activeId, activeSession]);
    // Dev has no "default directory" anymore: an unstaged welcome
    // composer preselects the most recent DEV session's project (a
    // daily session's workspace is not a code project to suggest). No
    // dev session yet (a brand-new install) keeps null — the send
    // button stays blocked with the "choose a project directory" hint
    // until the user picks one.
    useEffect(() => {
        if (mode !== "dev" || activeId !== null || pendingDirectory !== null) return;
        const recent = sessions.find((s) =>
            sessionMode(s) === "dev" && !!(s.directory ?? s.location?.directory)
        );
        const dir = recent?.directory ?? recent?.location?.directory;
        if (dir) setPendingDirectory(mainDirFor(dir));
    }, [mode, activeId, pendingDirectory, sessions]);

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

    /** Stage (or clear) the branch the NEXT session will be bound to.
     *  Pre-session only — a session's directory is immutable once
     *  created, so no in-session equivalent exists (see sendFirst). */
    const changeStagedBranch = useCallback((branch: string | null) => {
        setPendingBranch(branch);
    }, []);

    /** "New session" = back to the welcome screen (there is no empty-session
     *  view; the session is created on the first send, see sendFirst).
     *  Without an explicit folder (the sidebar-top button) the project
     *  defaults to the previous session's — the active session's directory,
     *  or the most recently updated one; already composing on the welcome
     *  screen keeps the user's in-progress choice untouched. */
    const newSession = useCallback((directory?: string) => {
        if (directory !== undefined) {
            // Explicit choice (a folder's "+") is taken literally — a
            // branch-worktree folder starts the next session in THAT
            // worktree (shared-checkout semantics on the pinned branch).
            setPendingDirectory(directory);
            setPendingBranch(null);
        } else if (activeId !== null) {
            const previous = activeSession ?? sessions[0];
            const dir = previous?.directory ?? previous?.location?.directory ?? null;
            // A branch-bound session's worktree is that one session's
            // isolation, not a project to nest the next session in —
            // seed its MAIN repo (worktreeSessions mapping).
            setPendingDirectory(dir === null ? null : mainDirFor(dir));
            setPendingBranch(null);
        }
        setActiveId(null);
    }, [activeId, activeSession, sessions]);

    /** The composer's project changed. There is no empty-session view —
     *  the session is created on the first send — so pre-session this just
     *  stages the choice; inside a conversation-less session (the picker
     *  only shows before the first message) drop the empty session and
     *  return to the welcome screen with the choice staged — nothing to
     *  lose before the first message, and moving it server-side would
     *  keep an empty session open. A branch staged for the PREVIOUS
     *  directory no longer applies, so an actual retarget clears it (the
     *  pickers are siblings now — this is the one place both meet). */
    const changeDirectory = useCallback((directory: string | null) => {
        if (!activeId) {
            if (directory !== pendingDirectory) setPendingBranch(null);
            setPendingDirectory(directory);
            return;
        }
        void remove(activeId);
        setPendingBranch(null);
        setPendingDirectory(directory);
        setActiveId(null);
    }, [activeId, remove, pendingDirectory]);

    /** First send from the welcome screen: create the session (in the chosen
     *  directory — a branch-bound send creates its linked WORKTREE first),
     *  apply the staged model/agent, then deliver the prompt (or run a
     *  slash command server-side). Image attachments divert to disk when
     *  the staged model is text-only (a vision-tool note is appended),
     *  exactly like an in-session send. */
    const sendFirst = useCallback(async (
        text: string,
        files: ComposerAttachment[],
        fileRefs: ComposerFileRef[] = [],
        command: PendingCommand | null = null,
    ) => {
        if (!api) return;
        // The mode decides the directory contract: DAILY lands in the
        // workspace's PER-SESSION subfolder
        // (<workspace>/Sessions/<first-prompt-slug>/, materialized +
        // claimed by its hidden marker — defaultWorkspace.ts; the
        // root's AGENTS.md still applies, OpenCode loads instructions
        // upward toward home), falling back to the workspace ROOT when
        // the folder cannot be resolved (today's behavior — a prompt
        // must never hand the server's bash a directory that doesn't
        // exist). DEV requires an explicit project (the "default
        // directory" escape hatch is gone; the UI disables sending
        // until one is picked, so a bare dev send here is a raced
        // button — refuse it rather than fall back to home).
        let directory: string | undefined;
        if (mode === "daily") {
            const workspace = await resolveDefaultWorkspace(api);
            if (workspace) {
                await ensureDefaultWorkspace(api, workspace); // best-effort, never throws
                const sessionDir = await resolveSessionDirectory(api, workspace, text);
                if (sessionDir) directory = sessionDir;
                else directory = workspace; // root fallback — the panel then sees the whole root
            }
        } else {
            if (!pendingDirectory) {
                warn("dev-mode send without a staged project directory; refusing").catch(() => {});
                return;
            }
            directory = pendingBranch
                ? await resolveBranchDirectory(api, pendingDirectory, pendingBranch)
                : pendingDirectory;
        }
        const created = await create(directory, mode);
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
        const {inline, note} = await divertAttachmentsForSend({
            api,
            attachments: files,
            acceptsImages: modelAcceptsImages(models, pendingModel),
        });
        const deliveredText = note ? `${text}\n\n${note}` : text;
        const promptFiles = [
            ...inline.map((f) => ({uri: f.uri, name: f.name})),
            ...fileRefs.map((r) => fileRefToPromptFile(r)),
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
            if (!command) return api.sendPrompt(created.id, deliveredText, promptFiles);
            try {
                await api.runSessionCommand(created.id, command.name, command.arguments);
            } catch (e) {
                error(`Command ${command.name} failed, sending as prompt: ${e}`).catch(() => {});
                undoPending?.(); // the fallback is a plain prompt now
                await api.sendPrompt(created.id, deliveredText, promptFiles);
            }
        })();
        await deliver.catch((e) => {
            error(`Failed to send prompt: ${e}`).catch(() => {});
            undoPending?.();
            // Keep the first message as a FAILED row in the new session's
            // transcript (retry affordance there) — the composer is gone
            // (the view already switched off the welcome screen) and a
            // dropped first message reads as "it vanished".
            appendFailedPrompt(created.id, {
                text: deliveredText,
                files: [
                    ...inline.map((f) => ({name: f.name, mime: f.mime, uri: f.uri})),
                    ...fileRefs.map((r) => fileRefToPromptFile(r)),
                ],
                ...(command ? {command} : {}),
            });
        });
    }, [api, create, mode, models, pendingAgent, pendingBranch, pendingDirectory, pendingModel]);

    const deleteSession = useCallback((id: string) => {
        void remove(id);
        setActiveId((cur) => (cur === id ? null : cur));
    }, [remove]);

    // DEV's "no default directory" rule, as a single derived flag the
    // composer chain renders from (the button's disabled hint and the
    // Enter-key intercept). Only the welcome screen can be blocked — an
    // open session already carries its directory.
    const sendBlocked = mode === "dev" && activeId === null && pendingDirectory === null;

    // Drop a restored session id the server no longer lists (deleted while we
    // were away), once the first session list has actually landed.
    useEffect(() => {
        if (sessionsLoaded && activeId && !sessions.some((s) => s.id === activeId)) {
            setActiveId(null);
        }
    }, [sessionsLoaded, sessions, activeId]);

    // Persist what a restart should land on: the open session (or the welcome
    // screen's staged project), plus the model / thinking depth / mode in use
    // and each mode's last-open session (mode switches restore them; the
    // current mode's entry is always settled by the sync effect above by the
    // time this runs — mode-switch renders update activeId first).
    useEffect(() => {
        saveState({
            sessionId: activeId,
            dailySessionId: modeSessionsRef.current.daily,
            devSessionId: modeSessionsRef.current.dev,
            model: effectiveModel,
            agent: effectiveAgent,
            directory: pendingDirectory,
        });
    }, [mode, activeId, effectiveModel, effectiveAgent, pendingDirectory]);

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
        pendingBranch,
        changeModel,
        changeAgent,
        changeStagedBranch,
        newSession,
        changeDirectory,
        sendFirst,
        deleteSession,
        sendBlocked,
    };
}
