import {useEffect} from "react";
import {info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {isMobileApp} from "../lib/platform.ts";
import {useConnection} from "../opencode/connectionContext.tsx";
import {readGlobalConfig} from "../opencode/configFiles.ts";
import {useMobileConnection} from "../opencode/mobileConnection.ts";
import {LuminaServerApi, useServerConnection} from "../opencode/serverConnection.ts";
import {
    SYNCED_KEYS,
    peekSettingsSyncFlags,
    planSettingsSync,
    pluginOptionIo,
    settingsSyncSettled,
    settingsSyncUploaded,
    subscribeSettingsSyncFlags,
    type SyncedKey,
    type SyncedKeyIo,
} from "../opencode/settingsSync.ts";
import {ensureLuminaToolsPlugin} from "../opencode/useLuminaTools.ts";
import {modelVisibilityIo} from "./useDisabledModels.ts";

/**
 * The settings-sync ENGINE (mounted ONCE in AppBody, beside
 * useServerFrp): reconciles the synced settings (the SYNCED_KEYS
 * whitelist — see opencode/settingsSync.ts for the model + policy)
 * against the account's authoritative copy on lumina-code-server.
 *
 * Connection: the desktop's Settings→Server connection, the mobile
 * app's account connection — whichever THIS client has. No connection
 * (or no opencode handle yet) = the effect stays idle; local edits
 * keep marking keys dirty and flush when a connection appears.
 *
 * Reconcile triggers: on start, on a slow poll (5 min), whenever the
 * window/app becomes visible again (mobile resume / desktop refocus —
 * the two moments another device's edit should surface soonest), and
 * ~2s after any dirty flag appears (a local save uploads promptly).
 *
 * Every reconcile round: GET the server copy → read all local values →
 * planSettingsSync decides per key → PUT the uploads (clearing dirty
 * only on success) → land the server values, RE-CHECKING dirty before
 * each landing (the race guard: a save made mid-await must never be
 * overwritten by the stale copy this round fetched).
 *
 * Failures are soft: a failed round logs a warn and leaves the dirty
 * flags intact — the next trigger retries. A 404 from GET means this
 * server predates the sync API (official deployments upgrade
 * separately): the engine disables itself for the session, with ONE
 * info line (not a warn per poll).
 */

/** The slow poll — a settings edit is rare; this only bounds how long
 * a passive client lags behind another device's change. */
const POLL_MS = 5 * 60_000;
/** A local save uploads after this quiet window (rapid successive
 * toggles coalesce into one PUT). */
const FLUSH_DEBOUNCE_MS = 2_000;

export function useSettingsSync(): void {
    const {api} = useConnection();
    // Both hooks are called unconditionally (rules of hooks); which
    // connection THIS client uses is a static platform fact.
    const desktop = useServerConnection();
    const mobile = useMobileConnection();
    const connection = isMobileApp() ? mobile : desktop;
    const url = connection?.url ?? "";
    const token = connection?.token ?? "";

    useEffect(() => {
        if (!api || !url || !token) return;

        const client = new LuminaServerApi(url, token);
        const io: Record<SyncedKey, SyncedKeyIo> = {
            systemPrompt: pluginOptionIo(
                "systemPrompt",
                () => readGlobalConfig(api),
                (options) => ensureLuminaToolsPlugin(api, options),
            ),
            visionModel: pluginOptionIo(
                "visionModel",
                () => readGlobalConfig(api),
                (options) => ensureLuminaToolsPlugin(api, options),
            ),
            modelVisibility: modelVisibilityIo(),
        };

        let inFlight = false;
        /** Set when the server answered 404 — this deployment predates
         * the sync API; stop asking for the session. */
        let unsupported = false;
        /** Set by the cleanup: an in-flight reconcile holding the OLD
         * connection's client must stop touching the old server the
         * moment its effect run is superseded (sign-out / account
         * switch rebuilds everything below). */
        let cancelled = false;

        const reconcile = async (): Promise<void> => {
            if (inFlight || unsupported) return;
            inFlight = true;
            try {
                let reply: {settings: Record<string, string>};
                try {
                    reply = await client.settingsGet();
                } catch (e) {
                    const status = (e as Error & {status?: number}).status;
                    if (status === 404) {
                        unsupported = true;
                        logInfo(
                            `[settings-sync] ${url} has no settings API (older server) — sync disabled this session`,
                        ).catch(() => {});
                        return;
                    }
                    throw e;
                }
                if (cancelled) return;
                const flags = peekSettingsSyncFlags();
                const local: Partial<Record<SyncedKey, string>> = {};
                for (const key of SYNCED_KEYS) {
                    const value = await io[key].readLocal().catch(() => null);
                    if (value !== null) local[key] = value;
                }
                const plan = planSettingsSync({
                    server: reply.settings,
                    local,
                    dirty: flags.dirty,
                    everSynced: flags.synced,
                });

                const uploadKeys = Object.keys(plan.uploads) as SyncedKey[];
                if (uploadKeys.length > 0) {
                    // A failed PUT throws past the uploads — dirty keys
                    // survive for the next round.
                    await client.settingsPut(plan.uploads as Record<string, string>);
                    settingsSyncUploaded(uploadKeys);
                    logInfo(`[settings-sync] uploaded: ${uploadKeys.join(", ")}`).catch(() => {});
                }
                if (cancelled) return;

                for (const key of Object.keys(plan.applies) as SyncedKey[]) {
                    // THE RACE GUARD: a key saved locally while this round
                    // was awaiting must keep the local value — skip the
                    // landing; the save's own flush will upload it.
                    if (peekSettingsSyncFlags().dirty.has(key)) continue;
                    const applied = await io[key]
                        .applyLocal(plan.applies[key] as string)
                        .catch(() => false);
                    if (applied) {
                        logInfo(`[settings-sync] applied ${key} from the server`).catch(() => {});
                        // A save that landed INSIDE applyLocal's await
                        // window can still be overwritten by this round's
                        // write (accepted residual race — window is a few
                        // hundred ms, both events are rare). It is at
                        // least observable: the warn names the key whose
                        // save the NEXT flush will re-upload.
                        if (peekSettingsSyncFlags().dirty.has(key)) {
                            logWarn(
                                `[settings-sync] ${key} was saved locally while its server value was landing — the save's flush will re-upload it`,
                            ).catch(() => {});
                        }
                    } else {
                        logWarn(`[settings-sync] could not land ${key} locally`).catch(() => {});
                    }
                }

                settingsSyncSettled(plan.settled);
            } catch (e) {
                // Transient by construction (network, server restart) —
                // a warn, never an error; the flags keep the retry state.
                logWarn(`[settings-sync] reconcile failed: ${e}`).catch(() => {});
            } finally {
                inFlight = false;
            }
        };

        void reconcile();
        const poll = setInterval(() => {
            void reconcile();
        }, POLL_MS);

        // Coming back to the foreground is when another device's edit
        // should surface: pull immediately (mobile resume + desktop
        // refocus — visibilitychange covers both).
        const onVisible = () => {
            if (document.visibilityState === "visible") void reconcile();
        };
        document.addEventListener("visibilitychange", onVisible);

        // A local save marks a key dirty → flush shortly after (the
        // debounce also coalesces the rapid toggles of one session).
        let debounce: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = subscribeSettingsSyncFlags(() => {
            if (debounce !== null) clearTimeout(debounce);
            debounce = setTimeout(() => {
                debounce = null;
                void reconcile();
            }, FLUSH_DEBOUNCE_MS);
        });

        return () => {
            cancelled = true;
            clearInterval(poll);
            document.removeEventListener("visibilitychange", onVisible);
            unsubscribe();
            if (debounce !== null) clearTimeout(debounce);
        };
        // url/token are the connection's identity; `api` is the opencode
        // handle (its identity encodes a restart's new port+password).
    }, [api, url, token]);
}
