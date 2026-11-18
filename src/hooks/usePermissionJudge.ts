import {useEffect, useRef, useSyncExternalStore} from "react";
import {info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeSession, PermissionRequest} from "../opencode/types.ts";
import type {OpencodeApi} from "../opencode/api/index.ts";
import type {OpencodeEventHandler} from "../opencode/useOpencode.ts";
import {useConnection} from "../opencode/connectionContext.tsx";
import {readGlobalConfig} from "../opencode/configFiles.ts";
import {
    LUMINA_JUDGE_AGENT_ID,
    luminaToolsPluginPath,
    readLuminaToolsOptions,
} from "../opencode/toolPluginConfig.ts";
import {readProjectPermissions} from "../opencode/projectPermissions.ts";
import type {PermissionModeId} from "../opencode/permissionModes.ts";
import {peekSessionMessages} from "../opencode/useSessionMessages.ts";
import {
    assistantReplyText,
    buildJudgePrompt,
    cachePut,
    cheapGate,
    JUDGE_MAX_CONCURRENT,
    JUDGE_TIMEOUT_MS,
    ladderDirectoryOf,
    markHeld,
    parseModelRef,
    parseVerdict,
    peekAudit,
    peekHeld,
    pushAudit,
    releaseHeld,
    resolveJudgeContext,
    signatureOf,
    subscribeAudit,
    subscribeHeld,
    type JudgeAuditEntry,
    type JudgeToolCall,
    type VerdictCache,
} from "../opencode/permissionJudge.ts";

/**
 * The permission judge's STATEFUL half (the pure planning + the module
 * stores live in opencode/permissionJudge.ts). Mounted ONCE beside
 * useSessionRequests in the SessionDataProvider: every
 * `permission.asked` passes the gate, and the survivors run a one-shot
 * judgment through a TRANSIENT helper session (agent
 * lumina-permission-judge + the user-selected model, metadata {source:
 * "lumina-tools"} — hidden from the sidebar, swept by useSessions'
 * 10s-delayed helper delete, and deleted by the runner's own finally
 * regardless).
 *
 * SILENT HOLD: while a judgment runs the ask is INVISIBLE — the card
 * never mounts, and the sidebar badge / desktop notification stay
 * quiet (useSessionRequests filters held ids out of pendingCounts, so
 * the notification's 0→N transition fires only when the judge hands
 * the ask BACK to the human, never during the silent wait). An
 * "allow" verdict replies `once` and the ask never surfaces at all —
 * the audit line (JudgeAuditRow) and the log are its only traces;
 * ask / timeout / failure release the hold and the card appears THEN.
 * The 10s JUDGE_TIMEOUT_MS bounds the silent window.
 *
 * Isolation from user sessions (why the helper marker is safe): the
 * judge session is never registered in the sidebar whitelist, its
 * execution-end notification is filtered by the helper check, and the
 * message store never tracks it (nothing mounts its transcript). The
 * sweep's delete is delayed 10s — the runner reads the reply within
 * milliseconds of execution-end, so there is no race.
 *
 * Concurrency: at most JUDGE_MAX_CONCURRENT model calls in flight;
 * further asks in the same burst show the card un-judged (identical
 * signatures collapse via the verdict cache, so bursts rarely exceed
 * one call anyway). Both a desktop and a mobile client mounted against
 * the same server judge independently — the loser's reply 404s
 * harmlessly (the settle contract).
 */

/** In-flight model calls (module level: one app run, one budget). */
let inFlight = 0;

/** The held ids — the card/badge suppressors subscribe through the
 *  module store (see permissionJudge.ts's SILENT-HOLD contract). */
export function useJudgeHeld(): ReadonlySet<string> {
    return useSyncExternalStore(subscribeHeld, peekHeld, peekHeld);
}

export function useJudgeAudit(): readonly JudgeAuditEntry[] {
    return useSyncExternalStore(subscribeAudit, peekAudit, peekAudit);
}

/** Resolve once the helper session's run reaches a terminal state (or
 *  the timeout fires — the caller then interrupts and falls back).
 *  Subscribed BEFORE the prompt POST so a fast model cannot slip an
 *  event between the send and the listener. */
function waitForRunEnd(
    subscribe: (handler: OpencodeEventHandler) => () => void,
    sessionID: string,
    timeoutMs: number,
): Promise<"ended" | "timeout"> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: "ended" | "timeout") => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            off();
            resolve(value);
        };
        const off = subscribe((event) => {
            if (settled) return;
            if (
                (event.type === "session.execution.succeeded" ||
                    event.type === "session.execution.failed" ||
                    event.type === "session.execution.interrupted") &&
                (event.data as {sessionID?: string}).sessionID === sessionID
            ) {
                finish("ended");
            }
        });
        const timer = setTimeout(() => finish("timeout"), timeoutMs);
    });
}

/** Directory → mode cache (the gate needs it per ask; reading the
 *  project config over fs/read every time would hammer the file). 30s
 *  TTL + config.updated invalidation below. */
const MODE_TTL_MS = 30_000;
const modeCache = new Map<string, {mode: PermissionModeId; at: number}>();

async function resolveMode(api: OpencodeApi, directory: string, now: number): Promise<PermissionModeId | null> {
    const hit = modeCache.get(directory);
    if (hit && hit.at > now - MODE_TTL_MS) return hit.mode;
    const state = await readProjectPermissions(api, directory);
    if (state.kind !== "ok") return null;
    modeCache.set(directory, {mode: state.mode, at: now});
    return state.mode;
}

export function usePermissionJudge(sessions: readonly OpencodeSession[]): void {
    const {api, subscribe} = useConnection();
    const apiRef = useRef<OpencodeApi | null>(null);
    apiRef.current = api;
    const subscribeRef = useRef(subscribe);
    subscribeRef.current = subscribe;
    const sessionsRef = useRef<readonly OpencodeSession[]>(sessions);
    sessionsRef.current = sessions;
    /** The configured judge model (compact "providerID/modelID" parsed);
     *  null = off. Refreshed on connect + every config.updated. */
    const modelRef = useRef<{providerID: string; modelID: string} | null>(null);
    const verdictCacheRef = useRef<VerdictCache>(new Map());

    // The judge model option — loaded from the global config, refreshed
    // whenever ANY config write lands (ours saves the plugin entry; a
    // hand edit works too — the server hot-reloads either way).
    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        const load = () => {
            readGlobalConfig(api).then((cfg) => {
                if (cancelled) return;
                if (!cfg) {
                    modelRef.current = null;
                    return;
                }
                const options = readLuminaToolsOptions(cfg.text ?? "", luminaToolsPluginPath(cfg.target.directory));
                const model = options?.permissionJudge?.model;
                modelRef.current = model ? parseModelRef(model) : null;
            }).catch((e) => {
                logWarn(`Permission judge: failed to read its model option: ${e}`).catch(() => {});
            });
        };
        load();
        const off = subscribeRef.current((event) => {
            if (event.type === "config.updated") {
                modeCache.clear();
                load();
            }
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [api]);

    // The ask intake + the judging lifecycle.
    useEffect(() => {
        const runJudge = async (
            request: PermissionRequest,
            toolCall: JudgeToolCall | null,
            lastUserText: string | null,
        ) => {
            const a = apiRef.current;
            const model = modelRef.current;
            if (!a || !model) return;
            inFlight += 1;
            markHeld(request.id);
            let helperId: string | null = null;
            try {
                const session = await a.createSession({
                    agent: LUMINA_JUDGE_AGENT_ID,
                    model,
                    metadata: {source: "lumina-tools"},
                    title: "permission-judge",
                });
                helperId = session.id;
                const ended = waitForRunEnd(subscribeRef.current, helperId, JUDGE_TIMEOUT_MS);
                await a.sendPrompt(helperId, buildJudgePrompt(request, toolCall, lastUserText));
                if ((await ended) === "timeout") {
                    a.interruptSession(helperId).catch(() => {});
                    logWarn(`Permission judge timed out on ${request.id}; falling back to the card`).catch(() => {});
                    return;
                }
                const page = await a.listMessagesPage(helperId);
                const verdict = parseVerdict(assistantReplyText(page.data ?? []));
                const now = Date.now();
                const sig = signatureOf(request);
                if (verdict && verdict.verdict === "allow") {
                    cachePut(verdictCacheRef.current, sig, verdict, now);
                    try {
                        await a.replyPermission(request.sessionID, request.id, "once");
                        pushAudit({
                            requestId: request.id,
                            sessionID: request.sessionID,
                            action: request.action,
                            resources: request.resources,
                            reason: verdict.reason,
                            time: now,
                        });
                        logInfo(
                            `Permission judge allowed ${request.action} ${request.resources.join(", ")}: ${verdict.reason || "(no reason)"}`,
                        ).catch(() => {});
                    } catch (e) {
                        // 404 = already settled (the human clicked first, or
                        // the sibling client judged too) — nothing to do.
                        if ((e as {status?: number}).status !== 404) {
                            logWarn(`Permission judge reply failed on ${request.id}: ${e}`).catch(() => {});
                        }
                    }
                } else {
                    // ask / unparseable — remember it so the SAME signature
                    // (the grouped siblings) skips straight to the card.
                    cachePut(verdictCacheRef.current, sig, {verdict: "ask", reason: verdict?.reason ?? ""}, now);
                    logInfo(`Permission judge asks the human (card released): ${verdict?.reason || "(no reason)"}`).catch(() => {});
                }
            } catch (e) {
                logWarn(`Permission judge run failed on ${request.id}: ${e}`).catch(() => {});
            } finally {
                inFlight -= 1;
                // Release the hold — the ask becomes visible unless the
                // reply already settled it (allow: permission.replied
                // released it first; idempotent either way).
                releaseHeld(request.id);
                if (helperId) {
                    a?.deleteSession(helperId).catch(() => {});
                }
            }
        };

        const onAsked = (request: PermissionRequest) => {
            const a = apiRef.current;
            if (!a) return;
            const model = modelRef.current;
            if (!model) return;
            // The cheap synchronous gate FIRST — an ask we will never
            // judge must not cost a config read. The tool call and user
            // intent come from the in-memory message store (sync, free).
            // Mode is resolved async after (the directory's project
            // config, TTL-cached).
            const messages = peekSessionMessages(request.sessionID);
            const {toolCall, lastUserText} = messages
                ? resolveJudgeContext(messages, request.source)
                : {toolCall: null, lastUserText: null};
            const cheap = cheapGate(request, toolCall, true, verdictCacheRef.current, Date.now());
            if (!cheap.proceed) {
                // Observability: every silent skip of the user-facing
                // feature logs its reason (asks are low-frequency,
                // user-visible events — one line each is fine).
                logInfo(`Permission judge skipped (${cheap.reason}): ${request.action} ${request.resources.join(", ")}`).catch(() => {});
                return;
            }
            const cached = cheap.cached;
            // v1 scope: only asks whose session we can map to a directory
            // (whitelisted root sessions). Subagent children and foreign
            // sessions are not in the sidebar list — their asks skip the
            // judge and show the card as before.
            const session = sessionsRef.current.find((s) => s.id === request.sessionID);
            const sessionDirectory = session?.location?.directory;
            if (!sessionDirectory) {
                logInfo(`Permission judge skipped (session not in the sidebar list): ${request.sessionID}`).catch(() => {});
                return;
            }
            // The ladder's directory ≠ the session's directory for DAILY
            // sessions (their per-session folders carry no config; the
            // workspace root owns the ladder — the same mapping the
            // permission picker makes).
            const directory = ladderDirectoryOf(sessionDirectory, session?.metadata?.["mode"]);
            void resolveMode(a, directory, Date.now()).then((mode) => {
                if (mode !== "balanced") {
                    logInfo(`Permission judge skipped (mode ${mode ?? "unknown"} in ${directory}): ${request.resources.join(", ")}`).catch(() => {});
                    return;
                }
                if (cached) {
                    if (cached.verdict === "allow") {
                        // A remembered allow — reply without a model call.
                        // Hold through the round trip so the card never
                        // flashes for the frame between asked and replied
                        // (the replied handler releases).
                        markHeld(request.id);
                        const now = Date.now();
                        a.replyPermission(request.sessionID, request.id, "once").then(() => {
                            pushAudit({
                                requestId: request.id,
                                sessionID: request.sessionID,
                                action: request.action,
                                resources: request.resources,
                                reason: cached.reason,
                                time: now,
                            });
                        }).catch((e) => {
                            if ((e as {status?: number}).status !== 404) {
                                logWarn(`Permission judge cached reply failed on ${request.id}: ${e}`).catch(() => {});
                            }
                            // The replied event never comes on failure —
                            // lift the hold ourselves.
                            releaseHeld(request.id);
                        });
                    }
                    // cached ask → straight to the card.
                    return;
                }
                if (inFlight >= JUDGE_MAX_CONCURRENT) {
                    logInfo("Permission judge skipped (busy — too many judgments in flight)").catch(() => {});
                    return;
                }
                void runJudge(request, toolCall, lastUserText);
            });
        };

        const off = subscribeRef.current((event) => {
            switch (event.type) {
                case "permission.asked": {
                    onAsked(event.data as PermissionRequest);
                    break;
                }
                case "permission.replied": {
                    // The ask settled (ours or the human's) — release the
                    // hold so nothing stays suppressed.
                    const {requestID} = event.data as {requestID: string};
                    releaseHeld(requestID);
                    break;
                }
            }
        });
        return off;
    }, []);
}
