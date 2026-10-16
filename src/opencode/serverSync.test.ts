import test from "node:test";
import assert from "node:assert/strict";

/**
 * The sync core's pure shaping (opencode/serverSync.ts). plugin-log
 * calls reject harmlessly inside the queue's catch — same dynamic-import
 * pattern as sessionRegistry.test.ts.
 */
const {
    toSyncEntry,
    mirrorableSessions,
    stripUnconfirmed,
    createSyncQueue,
    truncateDiffForMirror,
} = await import("./serverSync.ts");
import type {ChatMessage, OpencodeSession} from "./types.ts";

function session(over: Partial<OpencodeSession> = {}): OpencodeSession {
    return {
        id: "ses_1",
        projectID: "prj_1",
        directory: "/repo",
        agent: "build",
        ...over,
    } as OpencodeSession;
}

test("toSyncEntry maps title/directory/agent and flattens the model ref", () => {
    const entry = toSyncEntry(
        session({
            title: "Plan",
            model: {id: "glm-5.3", providerID: "zhipuai"},
        }),
    );
    assert.equal(entry.id, "ses_1");
    assert.equal(entry.title, "Plan");
    assert.equal(entry.directory, "/repo");
    assert.equal(entry.model, "zhipuai/glm-5.3");
    assert.equal(entry.agent, "build");
    assert.ok(entry.updatedAt);
});

test("toSyncEntry falls back to location.directory and blanks", () => {
    const entry = toSyncEntry(session({directory: undefined, location: {directory: "/alt"}}));
    assert.equal(entry.directory, "/alt");
    const bare = toSyncEntry(session({directory: undefined, title: undefined}));
    assert.equal(bare.directory, "");
    assert.equal(bare.title, "");
    assert.equal(bare.model, "");
});

test("mirrorableSessions keeps roots, drops subagent children and helper sessions", () => {
    const sessions = [
        session({id: "root_1"}),
        session({id: "child_1", parentID: "root_1"}),
        session({id: "helper_1", metadata: {source: "lumina-tools"}}),
        session({id: "root_2", directory: "/other"}),
    ];
    assert.deepEqual(
        mirrorableSessions(sessions).map((s) => s.id),
        ["root_1", "root_2"],
    );
});

test("stripUnconfirmed drops optimistic local-* bubbles only", () => {
    const messages = [
        {id: "local-abc", type: "user", text: "draft"},
        {id: "msg_1", type: "user", text: "real"},
        {id: "msg_2", type: "assistant", content: []},
    ] as ChatMessage[];
    const kept = stripUnconfirmed(messages);
    assert.deepEqual(kept.map((m) => m.id), ["msg_1", "msg_2"]);
    assert.equal(stripUnconfirmed([]).length, 0);
});

test("createSyncQueue serializes tasks and survives rejections", async () => {
    const queue = createSyncQueue("test");
    const order: string[] = [];
    const done = new Promise<void>((resolve) => {
        queue.run(async () => {
            await new Promise((r) => setTimeout(r, 10));
            order.push("slow");
        });
        queue.run(async () => {
            throw new Error("boom"); // must not block the chain
        });
        queue.run(async () => {
            order.push("after");
            resolve();
        });
    });
    await done;
    assert.deepEqual(order, ["slow", "after"]);
});

test("truncateDiffForMirror caps files and patch bytes", () => {
    const entry = (file: string, patch: string) => ({
        file,
        patch,
        additions: 1,
        deletions: 1,
        status: "modified",
    });
    // file cap
    const many = truncateDiffForMirror(Array.from({length: 500}, (_, i) => entry(`f${i}`, "p")));
    assert.equal(many.length, 200);
    // byte budget: the crossing file is clipped, the rest keep counts only
    const big = truncateDiffForMirror([
        entry("a", "x".repeat(1024 * 1024)),
        entry("b", "y".repeat(1024 * 1024)),
        entry("c", "z"),
    ]);
    assert.equal(big.length, 3);
    assert.equal(big[0].patch.length, 1024 * 1024);
    assert.equal(big[1].patch.length, 1024 * 1024); // remaining budget
    assert.equal(big[2].patch, ""); // budget exhausted → counts only
    // a single oversized patch still ships clipped (not dropped)
    const single = truncateDiffForMirror([entry("huge", "q".repeat(5 * 1024 * 1024))]);
    assert.equal(single[0].patch.length, 2 * 1024 * 1024);
});
