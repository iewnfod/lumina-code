import {createDatabase} from "../db/db.ts";
import {AuthError, createUser} from "./auth.ts";
import {getSyncedSettings, putSyncedSettings} from "./settings.ts";

import {describe, expect, it} from "vitest";

async function setup() {
  const db = createDatabase(":memory:");
  const u1 = await createUser(db, "desktop1", "password1");
  const u2 = await createUser(db, "desktop2", "password2");
  return {db, u1, u2};
}

describe("getSyncedSettings", () => {
  it("empty for an account that never wrote", async () => {
    const {db, u1} = await setup();
    expect(getSyncedSettings(db, u1.id)).toEqual({});
  });

  it("returns only that user's whitelisted keys", async () => {
    const {db, u1, u2} = await setup();
    putSyncedSettings(db, u1.id, {systemPrompt: '"hi"'});
    putSyncedSettings(db, u2.id, {visionModel: '""'});
    expect(getSyncedSettings(db, u1.id)).toEqual({systemPrompt: '"hi"'});
    expect(getSyncedSettings(db, u2.id)).toEqual({visionModel: '""'});
  });
});

describe("putSyncedSettings", () => {
  it("upserts each key independently, latest write winning", async () => {
    const {db, u1} = await setup();
    putSyncedSettings(db, u1.id, {systemPrompt: '"a"', visionModel: '"x/y"'});
    putSyncedSettings(db, u1.id, {systemPrompt: '"b"'});
    expect(getSyncedSettings(db, u1.id)).toEqual({
      systemPrompt: '"b"',
      visionModel: '"x/y"',
    });
  });

  it("accepts an empty batch as a no-op", async () => {
    const {db, u1} = await setup();
    expect(putSyncedSettings(db, u1.id, {})).toEqual({ok: true});
    expect(getSyncedSettings(db, u1.id)).toEqual({});
  });

  it("rejects non-object entries wholesale", async () => {
    const {db, u1} = await setup();
    for (const junk of [null, "x", 3, []]) {
      expect(() => putSyncedSettings(db, u1.id, junk)).toThrow(AuthError);
    }
    expect(getSyncedSettings(db, u1.id)).toEqual({});
  });

  it("rejects a non-whitelisted key without writing the batch", async () => {
    const {db, u1} = await setup();
    expect(() => putSyncedSettings(db, u1.id, {systemPrompt: '"a"', evil: '"x"'})).toThrow(
      AuthError,
    );
    // The batch is validated first — the valid key must not have landed.
    expect(getSyncedSettings(db, u1.id)).toEqual({});
  });

  it("rejects non-string values", async () => {
    const {db, u1} = await setup();
    expect(() => putSyncedSettings(db, u1.id, {systemPrompt: 5})).toThrow(AuthError);
    expect(() => putSyncedSettings(db, u1.id, {modelVisibility: null})).toThrow(AuthError);
  });

  it("rejects values over the size ceiling", async () => {
    const {db, u1} = await setup();
    const huge = `"${"x".repeat(65_537)}"`;
    expect(() => putSyncedSettings(db, u1.id, {systemPrompt: huge})).toThrow(AuthError);
  });
});
