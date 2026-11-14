import type {ComposerFileRef} from "../types.ts";
import {ApiTransport} from "./transport.ts";
import {sessionsApi, type SessionApi} from "./sessions.ts";
import {vcsApi, type VcsApi} from "./vcs.ts";
import {shellApi, type ShellApi} from "./shell.ts";
import {catalogApi, type CatalogApi} from "./catalog.ts";
import {requestsApi, type RequestApi} from "./requests.ts";
import {integrationsApi, type IntegrationApi} from "./integrations.ts";
import {configApi, type ConfigApi} from "./config.ts";
import {fsApi, type FsApi} from "./fs.ts";

export {UPLOAD_TIMEOUT_MS} from "./transport.ts";

/** A composer file reference as it rides the prompt's `files[]` —
 *  `file://` URLs point the server at the real file on disk. */
export function fileRefToPromptFile(ref: ComposerFileRef): {uri: string; name: string} {
    const base = ref.path.split("/").pop() ?? ref.path;
    return {uri: `file://${ref.path}`, name: base};
}

/**
 * Thin typed REST client for the opencode server — the ONE entry the rest
 * of the app consumes (`import … from "../opencode/api/index.ts"`). Every
 * server interaction in the codebase goes through this class; the endpoint
 * domains live as sibling files and compose onto it here, so the surface
 * stays pinned in one LIBRARY (this directory) while each domain file
 * stays independently readable.
 *
 * Hand-rolled instead of using the SDK's runtime because the installed
 * server (v2.0.x) and the SDK's generated client drift on paths and body
 * encoding — the endpoints we use are more predictable pinned here,
 * against the paths verified against the real server (see each domain
 * file for its endpoint map and the live-verified quirks):
 *   sessions.ts     — session lifecycle, prompts, inbox, revert
 *   vcs.ts          — working-copy/turn diffs, branches, worktrees
 *   shell.ts        — background shells + the awaitShell poll primitive
 *   catalog.ts      — models/agents/providers/projects/commands/switches
 *   requests.ts     — permission asks + forms (the server→user channels)
 *   integrations.ts — provider auth (API keys, OAuth, credentials)
 *   config.ts       — config documents, loaded plugins, MCP servers
 *   fs.ts           — location-confined reads + absolute-path writes
 *
 * The SDK stays as the source of some TypeScript shapes (types-only
 * import). Response envelope: the server wraps payloads as
 * `{"data": ...}`; the transport unwraps when present so callers get the
 * raw payload (transport.ts).
 *
 * COMPOSITION: the same-named interface below merges the domain method
 * declarations onto the class's instance type (declaration merging), and
 * the Object.assign pastes the method objects onto the prototype at
 * runtime — types and values stay in lockstep with zero inference
 * gymnastics. The domain objects are ThisType-bound to ApiTransport, so
 * their bodies see the (public-for-composition, @internal — see
 * transport.ts) plumbing members.
 */
export interface OpencodeApi extends
    ApiTransport,
    SessionApi,
    VcsApi,
    ShellApi,
    CatalogApi,
    RequestApi,
    IntegrationApi,
    ConfigApi,
    FsApi {}

export class OpencodeApi extends ApiTransport {
    constructor(baseUrl: string, authorization: string) {
        super(baseUrl, authorization);
    }
}

Object.assign(OpencodeApi.prototype, {
    ...sessionsApi,
    ...vcsApi,
    ...shellApi,
    ...catalogApi,
    ...requestsApi,
    ...integrationsApi,
    ...configApi,
    ...fsApi,
});
