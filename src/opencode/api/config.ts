import type {
    McpServerInfo,
    OpencodeConfigEntry,
    OpencodePluginInfo,
} from "../types.ts";
import {ApiTransport} from "./transport.ts";

/**
 * The CONFIG domain of the opencode REST client — config document
 * discovery plus the loaded plugin and MCP server lists (the
 * Extensions pane's data). Verified against server v2.0.11.
 *
 * The server only hot-reloads config from DISK, and its
 * `/api/experimental/config` PATCH accepts nothing but `shell` — so
 * custom providers are managed by rewriting the global opencode.json:
 * read raw (fs/read), merge the `provider` entry, write back
 * (experimental fs/write). The server picks the change up within ~2s
 * and emits config.updated / provider.updated / model.updated.
 */
export interface ConfigApi {
    listConfigEntries(): Promise<OpencodeConfigEntry[]>;
    listPlugins(directory?: string): Promise<OpencodePluginInfo[]>;
    listMcpServers(directory?: string): Promise<McpServerInfo[]>;
}

/** The config domain methods (see the interface); composed onto the
 *  OpencodeApi prototype in index.ts. */
export const configApi: ConfigApi & ThisType<ApiTransport> = {
    /** Config documents + discovery directories, lowest → highest
     *  priority. The first entry is the GLOBAL config location. */
    listConfigEntries(): Promise<OpencodeConfigEntry[]> {
        return this.request<OpencodeConfigEntry[]>("/api/config");
    },

    /** All LOADED plugins (`GET /api/plugin`, server v2.0.11). Includes
     *  the server's own `opencode.*` builtins (source.type "builtin" —
     *  filter for the user-manageable rows); a plugin disabled through a
     *  `plugins` remove directive is simply absent from the list. */
    listPlugins(directory?: string): Promise<OpencodePluginInfo[]> {
        return this.requestLocationData(`/api/plugin${this.locationQuery(directory)}`, [] as OpencodePluginInfo[]);
    },

    /** Every MCP server of the effective config with its live status
     *  (`GET /api/mcp`) — disabled ones included (status "disabled").
     *  Hot-reloads on config writes; `mcp.status.changed` signals flips. */
    listMcpServers(directory?: string): Promise<McpServerInfo[]> {
        return this.requestLocationData(`/api/mcp${this.locationQuery(directory)}`, [] as McpServerInfo[]);
    }
};
