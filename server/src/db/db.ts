import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import {CREATE_TABLES, MIGRATIONS, SCHEMA_VERSION} from "./schema.ts";

/**
 * Database open/init.
 *
 * One SQLite file, WAL mode, foreign keys on. `createDatabase` is the
 * pure entry (tests pass ":memory:" or a temp path); `getDb()` is the
 * process singleton resolving the file location from the environment:
 *
 *   LUMINA_DATA_DIR  — directory holding lumina.db (created if missing).
 *                      Default: ./data under the working directory.
 *
 * The singleton is cached on globalThis so Next dev-mode hot reloads (and
 * route handlers in different module graphs) share one connection —
 * better-sqlite3 is synchronous and single-connection, which is exactly
 * what this server needs.
 */

export type Db = Database.Database;

export function createDatabase(file: string): Db {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), {recursive: true});
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(CREATE_TABLES);

  // Recorded migrations: each entry runs once, keyed in the meta table.
  for (const [key, sql] of Object.entries(MIGRATIONS)) {
    const done = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | {value: string}
      | undefined;
    if (!done) {
      db.exec(sql);
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(key, "1");
    }
  }

  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
  ).run(String(SCHEMA_VERSION));
  return db;
}

interface DbGlobal {
  __luminaDb?: Db;
}

export function dataDir(): string {
  return process.env.LUMINA_DATA_DIR ?? path.join(process.cwd(), "data");
}

export function getDb(): Db {
  const g = globalThis as unknown as DbGlobal;
  if (!g.__luminaDb) {
    g.__luminaDb = createDatabase(path.join(dataDir(), "lumina.db"));
  }
  return g.__luminaDb;
}
