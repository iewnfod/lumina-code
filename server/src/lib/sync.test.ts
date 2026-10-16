import {createDatabase} from "../db/db.ts";
import {AuthError, createTokenForUser, createUser} from "./auth.ts";
import {
  applyMessagesSnapshot,
  applyDiffPush,
  applySessionPush,
  getDiff,
  listLiveSessions,
  parseDiffPush,
  parseSessionPush,
  type SessionPushEntry,
} from "./sync.ts";

import {describe, expect, it} from "vitest";

async function setup() {
  const db = createDatabase(":memory:");
  const u1 = await createUser(db, "desktop1", "password1");
  const u2 = await createUser(db, "desktop2", "password2");
  createTokenForUser(db, u1.id, "t");
  return {db, u1, u2};
}

function entry(id: string, over: Partial<SessionPushEntry> = {}): SessionPushEntry {
  return {
    id,
    title: `session ${id}`,
    directory: "/repo",
    model: "prov/model",
    agent: "build",
    updatedAt: "2026-10-05T00:00:00.000Z",
    ...over,
  };
}

describe("parseSessionPush", () => {
  it("validates and dedups", () => {
    const entries = parseSessionPush({
      sessions: [
        {id: "ses_1", title: "a"},
        {id: "ses_1", title: "a2"}, // last wins
        {id: "", title: "junk"}, // dropped
        "garbage", // dropped
      ],
    });
    expect(entries).toEqual([
      {
        id: "ses_1",
        title: "a2",
        directory: "",
        model: "",
        agent: "",
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("rejects non-array bodies", () => {
    expect(() => parseSessionPush({})).toThrow(AuthError);
    expect(() => parseSessionPush({sessions: "x"})).toThrow(AuthError);
  });
});

describe("applySessionPush", () => {
  it("upserts then tombstones vanished ids of the same owner only", async () => {
    const {db, u1, u2} = await setup();
    applySessionPush(db, u1.id, [entry("ses_a"), entry("ses_b")]);
    applySessionPush(db, u2.id, [entry("ses_c")]);
    expect(listLiveSessions(db).map((s) => s.id).sort()).toEqual([
      "ses_a",
      "ses_b",
      "ses_c",
    ]);

    // desktop1's next full list no longer contains ses_b → tombstoned;
    // desktop2's ses_c must survive that push.
    const result = applySessionPush(db, u1.id, [entry("ses_a")]);
    expect(result).toEqual({upserted: 1, tombstoned: 1});
    expect(listLiveSessions(db).map((s) => s.id).sort()).toEqual(["ses_a", "ses_c"]);

    // a session coming back un-tombstones it
    applySessionPush(db, u1.id, [entry("ses_a"), entry("ses_b")]);
    expect(listLiveSessions(db).map((s) => s.id).sort()).toEqual([
      "ses_a",
      "ses_b",
      "ses_c",
    ]);
  });

  it("tracks the freshest metadata", async () => {
    const {db, u1} = await setup();
    applySessionPush(db, u1.id, [entry("ses_a", {title: "one"})]);
    applySessionPush(db, u1.id, [entry("ses_a", {title: "two"})]);
    expect(listLiveSessions(db)[0].title).toBe("two");
  });
});

describe("applyMessagesSnapshot", () => {
  it("replaces wholesale and auto-creates the session row", async () => {
    const {db, u1} = await setup();
    const first = applyMessagesSnapshot(db, u1.id, "ses_x", [
      {id: "msg_1", type: "user", text: "hi"},
    ]);
    expect(first).toEqual({count: 1});
    applyMessagesSnapshot(db, u1.id, "ses_x", [
      {id: "msg_1", type: "user", text: "hi"},
      {id: "msg_2", type: "assistant", content: []},
    ]);
    const stored = db
      .prepare("SELECT payload FROM messages WHERE session_id = 'ses_x'")
      .get() as {payload: string};
    expect(JSON.parse(stored.payload)).toHaveLength(2);
    // session row auto-created + owner recorded
    const session = listLiveSessions(db).find((s) => s.id === "ses_x");
    expect(session?.owner).toBe("desktop1");
    expect(session?.hasSnapshot).toBe(true);
  });

  it("rejects non-array payloads", async () => {
    const {db, u1} = await setup();
    expect(() => applyMessagesSnapshot(db, u1.id, "ses_x", {nope: 1})).toThrow(AuthError);
    expect(() => applyMessagesSnapshot(db, u1.id, "", [])).toThrow(AuthError);
  });
});

describe("diff mirror", () => {
  it("push and read roundtrip, wholesale replace", async () => {
    const {db, u1} = await setup();
    applyDiffPush(
      db,
      u1.id,
      "/repo",
      parseDiffPush({
        directory: "/repo",
        entries: [{file: "a.ts", patch: "@@", additions: 3, deletions: 1, status: "modified"}],
      }).entries,
    );
    let result = getDiff(db, "/repo");
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0]).toEqual({
      file: "a.ts",
      patch: "@@",
      additions: 3,
      deletions: 1,
      status: "modified",
    });
    // second push replaces
    applyDiffPush(
      db,
      u1.id,
      "/repo",
      parseDiffPush({directory: "/repo", entries: [{file: "b.ts", patch: "", additions: 0, deletions: 0, status: "added"}]}).entries,
    );
    result = getDiff(db, "/repo");
    expect(result?.entries.map((e) => e.file)).toEqual(["b.ts"]);
    expect(getDiff(db, "/never")).toBeNull();
  });

  it("validates the push body", () => {
    expect(() => parseDiffPush({entries: []})).toThrow(AuthError);
    expect(() => parseDiffPush({directory: "/repo", entries: "x"})).toThrow(AuthError);
    expect(() => parseDiffPush({directory: "/repo", entries: Array(501).fill({file: "x"})})).toThrow(AuthError);
    // junk rows skipped, not fatal
    const ok = parseDiffPush({
      directory: "/repo",
      entries: [{file: ""}, "junk", {file: "ok.ts", patch: "p"}],
    });
    expect(ok.entries.map((e) => e.file)).toEqual(["ok.ts"]);
  });
});
