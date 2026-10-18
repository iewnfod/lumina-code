import {error as logError, info, warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import {globalConfigTarget} from "./configFiles.ts";
import {parseRegistryRaw} from "./sessionRegistry.ts";

/**
 * THE SERVER-SHARED half of the sidebar's session whitelist
 * (sessionRegistry.ts is the per-device local half): one id array at
 * `<global config dir>/lumina/whitelist.json` on the machine running the
 * opencode server, readable and writable by EVERY Lumina Code client
 * (desktop windows, the CEF shell, the mobile app) through the same fs
 * channel the lumina-tools installer already uses — `fs/read` is
 * location-confined to the directory, `experimental/fs/write` takes an
 * absolute path and creates parent dirs (all curl-verified on v2.0.11,
 * see api.ts). Session metadata CANNOT carry the marker retroactively
 * (v2.0.11's PATCH /api/session/{id} silently drops `metadata`, only
 * `title` sticks — live-verified), so the file is the only server-side
 * place membership can live for sessions that already exist.
 *
 * SEMANTICS — membership = local registry ∪ file content, derived at
 * every seed/relist (useSessions). The file only ever GROWS by union:
 * every writer reads fresh, unions its ids in, writes back; deletions
 * remove ids the SERVER no longer lists (dead-id compaction) or a
 * server-confirmed session delete — never a blind overwrite with a
 * local set. Direction guarantee: a sync race can delay one
 * registration from appearing on other devices (their next seed
 * re-pushes from the local layer and converges), but can never remove
 * a live session from any sidebar — the failure mode the whitelist
 * exists to prevent. The local registry doubles as the offline buffer
 * and the lost-update healing source (each seed union-pushes it).
 *
 * Failure ladder: no config target (GET /api/config empty — server
 * misbehaving) → everything degrades to the local-registry-only
 * behavior of the pre-shared era, logged once per connection. A read
 * that fails WITHOUT the absent markers (404 / 500-missing-dir, the
 * documented fs/read quirk) aborts the pending write too — rewriting
 * on an unreadable file could clobber another client's ids.
 */
const WHITELIST_DIR_NAME = "lumina";
const WHITELIST_FILE_NAME = "whitelist.json";

/** Union two id lists preserving the base's order (adds appended).
 * Exported for node:test coverage of the merge math. */
export function unionIds(base: readonly string[], extra: readonly string[]): string[] {
    const seen = new Set(base);
    const out = [...base];
    for (const id of extra) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/** The derived whitelist directory for the server this api points at
 * (per-handle cache: the mobile app can switch desktops, and the dir is
 * a SERVER-side fact derived from that server's config). */
const dirCache = new WeakMap<OpencodeApi, string>();

async function whitelistDir(api: OpencodeApi): Promise<string | null> {
    const cached = dirCache.get(api);
    if (cached) return cached;
    let entries;
    try {
        entries = await api.listConfigEntries();
    } catch (e) {
        logWarn(`Shared whitelist: config listing failed (${e}) — staying local-only this call`).catch(() => {});
        return null;
    }
    const target = globalConfigTarget(entries ?? []);
    // jsonc is NOT a blocker here (unlike the plugin installer): we
    // never rewrite the config document itself, we only borrow its
    // directory for our own data file.
    if (!target) return null;
    const dir = `${target.directory.replace(/\/+$/, "")}/${WHITELIST_DIR_NAME}`;
    dirCache.set(api, dir);
    return dir;
}

/** The last successfully read/merged file content — the server-half
 * input to membership derivation (union with the local registry).
 * Stale ids from a previous server are inert: derivation intersects
 * with the live server session list everywhere it matters. */
let snapshot: string[] = [];

/** Synchronous read of the shared-whitelist snapshot (empty until the
 * first successful read of the file — membership then degrades to the
 * local registry, i.e. the pre-shared behavior). */
export function serverWhitelistIds(): readonly string[] {
    return snapshot;
}

/**
 * Read the shared whitelist file. Returns the ids ([] when the file or
 * its directory does not exist yet — the fs/read 500-missing-dir quirk
 * is treated as absent, mirroring the plugin installer). THROWS on
 * unknown read failures: the caller must not treat those as "absent"
 * (adopting/pushing on an unreadable file could leak strangers into or
 * clobber the shared set). Updates the snapshot on success.
 */
export async function readWhitelist(api: OpencodeApi): Promise<string[]> {
    const dir = await whitelistDir(api);
    if (!dir) return snapshot;
    let raw: string | null;
    try {
        raw = await api.readTextFile(dir, WHITELIST_FILE_NAME);
    } catch (e) {
        if ((e as {status?: number}).status === 500) return [];
        throw e;
    }
    // A malformed (hand-corrupted) file reads as EMPTY, not absent —
    // the next merge rewrites it clean; there is nothing left to lose.
    const ids = (raw === null ? null : parseRegistryRaw(raw)) ?? [];
    snapshot = ids;
    return ids;
}

/** Never-throwing refresh for the relist path — a failed read keeps
 * the previous snapshot and logs (the local registry still carries
 * every id this device cares about). */
export async function refreshWhitelist(api: OpencodeApi): Promise<void> {
    try {
        await readWhitelist(api);
    } catch (e) {
        logWarn(`Shared whitelist unreadable — keeping the last snapshot: ${e}`).catch(() => {});
    }
}

export interface WhitelistMerge {
    /** Union these ids in (create / import / the stamp auto-register). */
    add?: readonly string[];
    /** Remove exactly these ids (a server-confirmed session delete). */
    remove?: readonly string[];
    /** Dead-id compaction: keep only ids present in this list (the
     * seed's reconcile against the live server list). An EMPTY list
     * compacts NOTHING — the transient-empty storage race guard. */
    compact?: readonly string[];
}

/**
 * The ONE write primitive: read fresh → apply remove → compact → add →
 * write back (only when the content changed). Never rejects; returns
 * the new ids, or null when the merge was skipped (no target, or the
 * file was unreadable in a way that forbids writing). The snapshot
 * follows the INTENDED content even when the disk write fails — this
 * device's derivation stays self-consistent and the next successful
 * merge re-attempts the persisted union.
 */
export async function mergeWhitelist(api: OpencodeApi, merge: WhitelistMerge): Promise<string[] | null> {
    const dir = await whitelistDir(api);
    if (!dir) return null;
    let current: string[];
    try {
        const raw = await api.readTextFile(dir, WHITELIST_FILE_NAME);
        current = (raw === null ? null : parseRegistryRaw(raw)) ?? [];
    } catch (e) {
        if ((e as {status?: number}).status === 500) {
            current = []; // directory not created yet — first write makes it
        } else {
            logError(`Shared whitelist unreadable, merge skipped (no clobber): ${e}`).catch(() => {});
            return null;
        }
    }
    let next = current.filter((id) => !merge.remove?.includes(id));
    if (merge.compact && merge.compact.length > 0) {
        const live = new Set(merge.compact);
        next = next.filter((id) => live.has(id));
    }
    next = unionIds(next, merge.add ?? []);
    snapshot = next;
    if (JSON.stringify(next) === JSON.stringify(current)) return next;
    try {
        await api.writeTextFile(`${dir}/${WHITELIST_FILE_NAME}`, JSON.stringify(next));
        info(
            `Shared session whitelist: ${current.length} → ${next.length} id(s)` +
                `${merge.remove?.length ? `, -${merge.remove.length}` : ""}` +
                `${merge.compact ? " (compacted)" : ""}`,
        ).catch(() => {});
    } catch (e) {
        logError(`Shared whitelist write failed (kept in memory, retried on next merge): ${e}`).catch(() => {});
    }
    return next;
}
