import type {
    OpencodeAgent,
    OpencodeCommand,
    OpencodeModel,
    OpencodeProject,
    OpencodeProvider,
    SessionModelRef,
} from "../types.ts";
import {ApiTransport} from "./transport.ts";

/**
 * The CATALOG domain of the opencode REST client — models, agents,
 * providers, projects, slash commands, the server-side file finder,
 * command execution inside a session, and the model/agent switches.
 * Everything verified against server v2.0.11 unless noted.
 */
export interface CatalogApi {
    listModels(): Promise<OpencodeModel[]>;
    listCommands(directory?: string | null): Promise<OpencodeCommand[]>;
    findFiles(query: string, directory?: string | null): Promise<{absolute: string; relative: string}[]>;
    runSessionCommand(sessionId: string, command: string, args: string): Promise<unknown>;
    getDefaultModel(): Promise<OpencodeModel | null>;
    listAgents(): Promise<OpencodeAgent[]>;
    listProviders(): Promise<OpencodeProvider[]>;
    listProjects(): Promise<OpencodeProject[]>;
    getLocation(): Promise<{directory?: string}>;
    switchModel(sessionId: string, model: SessionModelRef): Promise<void>;
    switchAgent(sessionId: string, agent: string): Promise<void>;
}

/** The catalog domain methods (see the interface); composed onto the
 *  OpencodeApi prototype in index.ts. */
export const catalogApi: CatalogApi & ThisType<ApiTransport> = {
    /** Available models (includes each model's thinking-depth variants). */
    listModels(): Promise<OpencodeModel[]> {
        return this.request<OpencodeModel[]>("/api/model");
    },

    /** User-defined slash commands (markdown templates), scoped to a
     *  location: project-local `.opencode/commands/` (and the built-ins,
     *  which only register inside a project) appear when the directory is
     *  passed as the bracket-form `location[directory]` query param — the
     *  same form {@link findFiles} uses. Without it the server answers for
     *  its default location (the server process's own cwd). */
    listCommands(directory?: string | null): Promise<OpencodeCommand[]> {
        return this.request<OpencodeCommand[]>(`/api/command${this.locationQuery(directory)}`);
    },

    /** Server-side fuzzy file finder — ranked by the server (respects
     *  .gitignore). Verified against server v2.0.11: the SDK's
     *  `/find/file` does not exist there; the real route is
     *  `GET /api/fs/find` with the directory as a bracket-form
     *  `location[directory]` query param, returning `{location, data}`
     *  where `data[].path` is RELATIVE to that location — we return both
     *  forms (short display path + absolute for the file:// URI). */
    findFiles(query: string, directory?: string | null): Promise<{absolute: string; relative: string}[]> {
        const search = this.locationQuery(directory, {query, type: "file"});
        return this.requestRaw<{location?: {directory?: string}; data?: {path: string; type?: string}[]}>(
            `/api/fs/find${search}`,
        ).then((r) => {
            const base = (directory ?? r?.location?.directory ?? "").replace(/\/+$/, "");
            return (r?.data ?? [])
                .filter((f) => f.type !== "directory")
                .map((f) => ({
                    relative: f.path,
                    absolute: base && !f.path.startsWith("/") ? `${base}/${f.path}` : f.path,
                }));
        });
    },

    /** Execute a slash command inside a session (server expands the
     *  template and runs it like a prompt). Verified against server
     *  v2.0.11: the body is `{name, text}` — `name` is the command and
     *  `text` carries the arguments (the server substitutes them into
     *  $ARGUMENTS, or appends them after the template when it has no
     *  placeholder). The older `{command, arguments}` shape is rejected
     *  with 400 "Missing key [\"name\"]". */
    runSessionCommand(sessionId: string, command: string, args: string): Promise<unknown> {
        return this.request(`/api/session/${encodeURIComponent(sessionId)}/command`, {
            method: "POST",
            body: JSON.stringify({name: command, text: args}),
        });
    },

    /** The server's current default model. */
    getDefaultModel(): Promise<OpencodeModel | null> {
        return this.request<OpencodeModel | null>("/api/model/default");
    },

    /** Agents ("modes"): build/plan/… plus internal subagents (filter those). */
    listAgents(): Promise<OpencodeAgent[]> {
        return this.request<OpencodeAgent[]>("/api/agent");
    },

    /** Active providers (the user's authenticated ones plus the free catalog). */
    listProviders(): Promise<OpencodeProvider[]> {
        return this.request<OpencodeProvider[]>("/api/provider");
    },

    /** Directories the server already knows as projects. */
    listProjects(): Promise<OpencodeProject[]> {
        return this.request<OpencodeProject[]>("/api/project");
    },

    /** The server's own working directory — browsing starts here. */
    getLocation(): Promise<{directory?: string}> {
        return this.request<{directory?: string}>("/api/location");
    },

    /** Point a session at another model (variant = thinking depth). */
    switchModel(sessionId: string, model: SessionModelRef): Promise<void> {
        return this.request<void>(
            `/api/session/${encodeURIComponent(sessionId)}/model`,
            {method: "POST", body: JSON.stringify({model})},
        );
    },

    /** Point a session at another agent ("mode"). */
    switchAgent(sessionId: string, agent: string): Promise<void> {
        return this.request<void>(
            `/api/session/${encodeURIComponent(sessionId)}/agent`,
            {method: "POST", body: JSON.stringify({agent})},
        );
    }
};
