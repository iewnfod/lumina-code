import type {NextConfig} from "next";

/**
 * lumina-server: a small self-hostable companion server for Lumina Code.
 *
 * One Next.js app serves BOTH the REST API used by the desktop/mobile
 * clients (`/api/auth/*`, `/api/sync/*`) and the minimal web management
 * UI. Storage is a single SQLite file (better-sqlite3) — no external
 * database, backups are file copies.
 */
const nextConfig: NextConfig = {
  // The Docker image runs the standalone server output.
  output: "standalone",
  // Native module: keep it out of the bundler so its .node binary is
  // require()'d at runtime from node_modules.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
