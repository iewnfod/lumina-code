import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {afterAll, describe, expect, it} from "vitest";

import {createDatabase, type Db} from "./db.ts";

/** A throwaway on-disk database (exercises the dir-creation path too). */
function tempDb(): {db: Db; dir: string} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-server-"));
  const db = createDatabase(path.join(dir, "sub", "lumina.db"));
  return {db, dir};
}

const dirs: string[] = [];

describe("createDatabase", () => {
  it("creates tables and starts at schema_version 1", () => {
    const db = createDatabase(":memory:");
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as {value: string};
    expect(row.value).toBe("1");
    for (const table of ["users", "tokens", "sessions", "messages"]) {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
      ).toBeTruthy();
    }
  });

  it("enforces unique usernames", () => {
    const db = createDatabase(":memory:");
    db.prepare(
      "INSERT INTO users (username, password_hash, role, created_at) VALUES ('a', 'h', 'user', '2026')",
    ).run();
    expect(() =>
      db.prepare(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES ('a', 'h2', 'user', '2026')",
      ).run(),
    ).toThrow();
  });

  it("cascades token deletion with its user, messages with its session", () => {
    const db = createDatabase(":memory:");
    db.prepare(
      "INSERT INTO users (username, password_hash, role, created_at) VALUES ('u', 'h', 'user', '2026')",
    ).run();
    const uid = (
      db.prepare("SELECT id FROM users WHERE username='u'").get() as {id: number}
    ).id;
    db.prepare("INSERT INTO tokens (user_id, token_hash, created_at) VALUES (?, 't1', '2026')").run(uid);
    db.prepare(
      "INSERT INTO sessions (opencode_session_id, updated_at, owner_user_id) VALUES ('ses_1', '2026', ?)",
    ).run(uid);
    db.prepare(
      "INSERT INTO messages (session_id, payload, updated_at) VALUES ('ses_1', '[]', '2026')",
    ).run();

    db.prepare("DELETE FROM users WHERE id = ?").run(uid);
    expect(db.prepare("SELECT COUNT(*) c FROM tokens").get()).toEqual({c: 0});
    expect(db.prepare("SELECT COUNT(*) c FROM sessions").get()).toEqual({c: 0});
    expect(db.prepare("SELECT COUNT(*) c FROM messages").get()).toEqual({c: 0});
  });

  it("creates the data directory on demand (on-disk file)", () => {
    const {db, dir} = tempDb();
    dirs.push(dir);
    expect(
      db.prepare("SELECT COUNT(*) c FROM users").get(),
    ).toEqual({c: 0});
  });
});

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, {recursive: true, force: true});
});
