import { hapTasks } from '@ohos/hvigor-ohos-plugin';
import { hvigor, HvigorPlugin, HvigorNode } from '@ohos/hvigor';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

export default {
  system: hapTasks,  /* Built-in plugin of Hvigor. It cannot be modified. */
  plugins:[tauriPlugin()]         /* Custom plugin to extend the functionality of Hvigor. */
}

function tauriPlugin(): HvigorPlugin {
  return {
    pluginId: 'tauri',
    apply(node: HvigorNode) {
      const buildRustCode = () => {
        const properties = hvigor.getParameter().getProperties();
        const target = properties.target || "aarch64";
        // Lumina Code note: wrapped in try/catch. The script fetches its
        // options from a WebSocket server that only exists while a
        // `cargo tauri ohos dev` (or an IDE-driven tauri dev session) is
        // alive — under the plain CLI flow hvigor's first build runs
        // BEFORE that server starts, so the script finds a stale address
        // file and panics (ConnectionRefused). In that flow the CLI has
        // ALREADY compiled the Rust library itself, so skipping the hook
        // is correct. The IDE Run flow keeps a live server and is
        // unaffected.
        try {
          execFileSync(`cargo`,
            ["tauri", "ohos", "dev-eco-studio-script", "--target", target.toString()], {
              cwd: resolve(__dirname, "../../../"),
              stdio: "inherit",
            });
        } catch {
          console.warn('[tauri] dev-eco-studio-script unavailable — assuming CLI already built the Rust library');
        }
      }

      node.getTaskByName('default@ConfigureCmake')!.afterRun(buildRustCode);
    }
  }
}
