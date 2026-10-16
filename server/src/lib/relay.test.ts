import {createDatabase} from "../db/db.ts";
import {AuthError, createTokenForUser, createUser} from "./auth.ts";
import {applySessionPush} from "./sync.ts";
import {ackPrompt, enqueuePrompt, pendingPrompts, pollPrompts} from "./relay.ts";

import {describe, expect, it} from "vitest";

async function setup() {
  const db = createDatabase(":memory:");
  const owner = await createUser(db, "desktop", "password1");
  const sender = await createUser(db, "phone", "password2");
  applySessionPush(db, owner.id, [
    {
      id: "ses_own",
      title: "t",
      directory: "/r",
      model: "",
      agent: "",
      updatedAt: new Date().toISOString(),
    },
    {
      id: "ses_tombstoned",
      title: "t",
      directory: "/r",
      model: "",
      agent: "",
      updatedAt: new Date().toISOString(),
    },
  ]);
  // tombstone ses_tombstoned via a list without it
  applySessionPush(db, owner.id, [
    {
      id: "ses_own",
      title: "t",
      directory: "/r",
      model: "",
      agent: "",
      updatedAt: new Date().toISOString(),
    },
  ]);
  createTokenForUser(db, owner.id, "t");
  return {db, owner, sender};
}

describe("relay queue", () => {
  it("enqueue → poll by the OWNER → ack removes; un-acked re-delivers", async () => {
    const {db, owner, sender} = await setup();
    enqueuePrompt(db, sender.id, sender.username, "ses_own", "run the tests");
    enqueuePrompt(db, sender.id, sender.username, "ses_own", "then build");

    let pending = await pollPrompts(db, owner.id, 0);
    expect(pending.map((p) => p.text)).toEqual(["run the tests", "then build"]);
    expect(pending[0]).toMatchObject({sessionId: "ses_own", from: "phone"});

    // partial processing: ack the first only
    ackPrompt(db, owner.id, pending[0].id);
    pending = await pollPrompts(db, owner.id, 0);
    expect(pending.map((p) => p.text)).toEqual(["then build"]);
    // un-acked rows re-deliver (at-least-once)
    pending = await pollPrompts(db, owner.id, 0);
    expect(pending).toHaveLength(1);
  });

  it("another user's poll sees nothing (ownership scoping)", async () => {
    const {db, owner, sender} = await setup();
    enqueuePrompt(db, sender.id, sender.username, "ses_own", "hello");
    // the SENDER owns no sessions — their poll is empty
    expect(await pollPrompts(db, sender.id, 0)).toEqual([]);
    expect((await pollPrompts(db, owner.id, 0)).length).toBe(1);
  });

  it("validates session liveness and text", async () => {
    const {db, owner, sender} = await setup();
    expect(() => enqueuePrompt(db, sender.id, sender.username, "ses_missing", "x")).toThrow(AuthError);
    expect(() => enqueuePrompt(db, sender.id, sender.username, "ses_tombstoned", "x")).toThrow(AuthError);
    expect(() => enqueuePrompt(db, sender.id, sender.username, "ses_own", "")).toThrow(AuthError);
    expect(() => enqueuePrompt(db, sender.id, sender.username, "ses_own", "x".repeat(20_001))).toThrow(AuthError);
    void owner;
  });

  it("ack is scoped to the owning desktop", async () => {
    const {db, owner, sender} = await setup();
    const {id} = enqueuePrompt(db, sender.id, sender.username, "ses_own", "hi");
    // the sender cannot ack (they don't own the session)
    expect(() => ackPrompt(db, sender.id, id)).toThrow(AuthError);
    ackPrompt(db, owner.id, id);
    expect(pendingPrompts(db, owner.id)).toEqual([]);
  });

  it("long poll waits then returns empty (short deadline)", async () => {
    const {db, owner} = await setup();
    const start = Date.now();
    const rows = await pollPrompts(db, owner.id, 500);
    expect(rows).toEqual([]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(400);
  });
});
