// Tests for the plan-document pure helpers named-exported from the plugin
// source. The plugin file is plain ESM with no top-level imports, so node
// loads it directly; the server only ever reads its default export (the
// named exports exist precisely for these tests — keep them side-effect
// free).
import assert from "node:assert/strict";
import {test} from "node:test";
import {
    anchorComment,
    buildStoredZip,
    claimGate,
    collectStallSignals,
    composePlanDoc,
    composeReportDoc,
    composeTasksDoc,
    configGuideFor,
    customSystemPrompt,
    errorFingerprint,
    gateIsCurrent,
    historyFileName,
    planDirName,
    planFileSlug,
    planStateFromEntries,
    renderStallWarning,
} from "./luminaTools.js";

const NOW = new Date(2026, 8, 25, 14, 30); // 2026-09-25, local fields only

test("planFileSlug keeps unicode letters and digits, collapses the rest", () => {
    assert.equal(planFileSlug("Add Todo Workflow!"), "add-todo-workflow");
    assert.equal(planFileSlug("重构  计划——v2"), "重构-计划-v2");
    assert.equal(planFileSlug("  --It's a  PLAN--  "), "its-a-plan");
    assert.equal(planFileSlug("!!!"), "plan"); // nothing left → fallback
    assert.equal(planFileSlug(""), "plan");
    assert.equal(planFileSlug(null), "plan");
});

test("planFileSlug caps long titles without trailing dashes", () => {
    const slug = planFileSlug("a".repeat(100));
    assert.equal(slug.length, 60);
    assert.match(slug, /^a+$/);
});

test("customSystemPrompt trims, tolerates junk, off on empty", () => {
    assert.equal(customSystemPrompt({systemPrompt: "  Be terse.  "}), "Be terse.");
    // Multiline prose survives verbatim (inner whitespace untouched).
    assert.equal(customSystemPrompt({systemPrompt: "Line one\nLine two"}), "Line one\nLine two");
    // Off states: absent, non-string, whitespace-only.
    assert.equal(customSystemPrompt({}), "");
    assert.equal(customSystemPrompt(undefined), "");
    assert.equal(customSystemPrompt({systemPrompt: "   \n\t "}), "");
    assert.equal(customSystemPrompt({systemPrompt: 42}), "");
    // Other options (per-tool namespaces) coexist untouched.
    assert.equal(customSystemPrompt({vision: {model: "x/y"}, systemPrompt: " hi "}), "hi");
});

test("planDirName slugs and disambiguates collisions", async () => {
    const taken = new Set(["add-todo"]);
    assert.equal(await planDirName("Add Todo", () => false), "add-todo");
    assert.equal(await planDirName("Add Todo", (n) => taken.has(n)), "add-todo-2");
    const more = new Set(["add-todo", "add-todo-2"]);
    assert.equal(await planDirName("Add Todo", (n) => more.has(n)), "add-todo-3");
    // Async probes (the fs round-trip) work the same.
    assert.equal(await planDirName("Add Todo", async (n) => taken.has(n)), "add-todo-2");
});

test("historyFileName stamps date+minute and disambiguates collisions", async () => {
    assert.equal(await historyFileName("plan", NOW, () => false), "plan-2026-09-25-1430.md");
    const taken = new Set(["report-2026-09-25-1430.md"]);
    assert.equal(await historyFileName("report", NOW, (n) => taken.has(n)), "report-2026-09-25-1430-2.md");
});

test("gate generations supersede older poll loops, scoped per session", () => {
    // The rejection-path race: an interrupt does NOT abort a plugin
    // executor's context.signal (live-observed 2026-09-28), so a rejected
    // work_submit/plan_submit keeps polling. A newer submission's claim
    // must fence it out within one tick.
    const first = claimGate("ses_a");
    assert.equal(gateIsCurrent("ses_a", first), true);
    const second = claimGate("ses_a");
    assert.ok(second > first, "claiming bumps the generation");
    assert.equal(gateIsCurrent("ses_a", first), false, "the rejected earlier executor is a zombie now");
    assert.equal(gateIsCurrent("ses_a", second), true);
    // Sessions are independent — a claim in one never fences another.
    assert.equal(gateIsCurrent("ses_b", second), false);
    assert.equal(gateIsCurrent("ses_b", claimGate("ses_b")), true);
});

// planStateFromEntries fixtures — entry shape as toolEntries produces it.
const submit = (over = {}) => ({
    name: "plan_submit",
    input: {title: "Plan A", plan: "# Plan A", todos: ["first task", "second task"]},
    ok: true,
    running: false,
    ...over,
});
const progress = (name, input, over = {}) => ({name, input, ok: true, running: false, ...over});

test("planStateFromEntries: completed plan_submit defines the list, progress advances it", () => {
    const state = planStateFromEntries([
        submit(),
        progress("task_complete", {title: "first task"}),
        progress("task_complete", {title: "second task"}),
        progress("work_submit", {report: "done"}),
    ]);
    assert.equal(state.title, "Plan A");
    assert.deepEqual(
        state.items.map((i) => i.status),
        ["completed", "completed"],
    );
    assert.equal(state.archived, true);
});

test("planStateFromEntries: a plan_submit frozen running counts as approved only under agent build", () => {
    const frozen = submit({ok: false, running: true});
    // Live gate (agent plan) or undecided orphan: NOT an executable plan.
    assert.equal(planStateFromEntries([frozen], "plan"), null);
    assert.equal(planStateFromEntries([frozen], undefined), null);
    // Restart recovery: agent=build is the approval itself — the frozen
    // part's todos define the list.
    const state = planStateFromEntries([frozen], "build");
    assert.equal(state.title, "Plan A");
    assert.deepEqual(
        state.items.map((i) => i.status),
        ["pending", "pending"],
    );
    // A rejected/errored part never counts, whatever the agent.
    assert.equal(planStateFromEntries([submit({ok: false, running: false})], "build"), null);
});

test("planStateFromEntries: recovery accepts task_complete on a frozen-approved plan", () => {
    const state = planStateFromEntries(
        [
            submit({ok: false, running: true}),
            progress("task_complete", {title: "first task"}),
        ],
        "build",
    );
    assert.deepEqual(
        state.items.map((i) => i.status),
        ["completed", "pending"],
    );
    // Under agent plan the same transcript has no plan at all — the
    // progress event finds no list and is ignored.
    assert.equal(
        planStateFromEntries(
            [
                submit({ok: false, running: true}),
                progress("task_complete", {title: "first task"}),
            ],
            "plan",
        ),
        null,
    );
});

test("planStateFromEntries: running progress events never count, only completed ones", () => {
    const state = planStateFromEntries(
        [
            submit(),
            progress("task_complete", {title: "first task"}, {ok: false, running: true}),
            progress("task_complete", {title: "first task"}, {ok: false, running: false}),
            progress("work_submit", {report: "x"}, {ok: false, running: true}),
        ],
        "build",
    );
    assert.deepEqual(
        state.items.map((i) => i.status),
        ["pending", "pending"],
    );
    assert.ok(!state.archived, "a running work_submit gate is not an acceptance");
});

test("composePlanDoc carries the anchor and the body verbatim (no added heading)", () => {
    const doc = composePlanDoc("ses_1", "# Plan A\n\nBody text.\n\n");
    assert.equal(doc, "<!-- lumina: session=ses_1 -->\n\n# Plan A\n\nBody text.\n");
});

test("composeReportDoc carries the anchor and the body verbatim (no added heading)", () => {
    const doc = composeReportDoc("ses_1", "# 验收汇报\n\nAll tests pass.\n");
    assert.equal(doc, "<!-- lumina: session=ses_1 -->\n\n# 验收汇报\n\nAll tests pass.\n");
});

test("composeTasksDoc renders status boxes with blocked reasons", () => {
    const doc = composeTasksDoc("ses_1", "Plan A", [
        {title: "one", status: "completed"},
        {title: "two", status: "blocked", reason: "missing dep"},
        {title: "three", status: "pending"},
    ]);
    assert.match(doc, /^<!-- lumina: session=ses_1 -->\n\n# Tasks — Plan A\n\n> Maintained by Lumina Code/);
    assert.match(doc, /- \[x\] one/);
    assert.match(doc, /- \[!\] two — blocked: missing dep/);
    assert.match(doc, /- \[ \] three/);
});

test("anchorComment embeds the session id", () => {
    assert.equal(anchorComment("ses_abc"), "<!-- lumina: session=ses_abc -->");
});

test("buildStoredZip lays out local headers, central directory and EOCD", () => {
    const zip = buildStoredZip(
        [
            {name: "plan.md", content: "# hello"},
            {name: "history/plan-2026-09-25-1430.md", content: "old"},
        ],
        NOW,
    );
    const dv = (off) => new DataView(zip.buffer, zip.byteOffset + off, zip.byteLength - off);

    // First local file header.
    const l0 = dv(0);
    assert.equal(l0.getUint32(0, true), 0x04034b50);
    assert.equal(l0.getUint16(8, true), 0); // stored
    assert.equal(l0.getUint16(6, true) & 0x0800, 0x0800); // UTF-8 name flag
    const nameLen = l0.getUint16(26, true);
    assert.equal(new TextDecoder().decode(zip.slice(30, 30 + nameLen)), "plan.md");
    const dataLen = l0.getUint32(22, true);
    assert.equal(new TextDecoder().decode(zip.slice(30 + nameLen, 30 + nameLen + dataLen)), "# hello");

    // EOCD at the very tail points back at the central directory.
    const eocdOff = zip.byteLength - 22;
    const ev = dv(eocdOff);
    assert.equal(ev.getUint32(0, true), 0x06054b50);
    assert.equal(ev.getUint16(8, true), 2); // entries on this disk
    assert.equal(ev.getUint16(10, true), 2); // total entries
    const cdOff = ev.getUint32(16, true);
    const cdSize = ev.getUint32(12, true);
    assert.equal(cdOff + cdSize, eocdOff);

    // First central directory record mirrors the local one.
    const c0 = dv(cdOff);
    assert.equal(c0.getUint32(0, true), 0x02014b50);
    assert.equal(c0.getUint32(42, true), 0); // local header offset of entry 0
});

test("buildStoredZip computes known CRC-32 values", () => {
    // crc32("hello") = 0x3610a686, crc32("") = 0 — IEEE 802.3 answers.
    const zip = buildStoredZip([{name: "a", content: "hello"}, {name: "b", content: ""}], NOW);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    assert.equal(dv.getUint32(14, true), 0x3610a686);
    // Entry 1's local header follows entry 0 (30 + len("a") + 5 bytes).
    const off1 = 30 + 1 + 5;
    assert.equal(dv.getUint32(off1 + 14, true), 0);
});

// --- fs-touching helpers (real temp directories) ---

import {mkdtemp, readdir, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {archiveTaskDirectory, sweepOrphanAcceptance, writePlanSubmission, writeReportSubmission, writeTasksState} from "./luminaTools.js";

async function withTempDir(fn) {
    const dir = await mkdtemp(join(tmpdir(), "lumina-plan-"));
    try {
        await fn(dir);
    } finally {
        await rm(dir, {recursive: true, force: true}).catch(() => {});
    }
}

test("writePlanSubmission creates the anchored directory with history and newest plan", async () => {
    await withTempDir(async (root) => {
        const dirName = await writePlanSubmission(root, "ses_a", "My Plan", "# body v1");
        assert.equal(dirName, "my-plan");
        const dir = join(root, ".lumina/tasks/my-plan");
        const plan = await readFile(join(dir, "plan.md"), "utf8");
        assert.match(plan, /^<!-- lumina: session=ses_a -->\n\n# body v1\n$/);
        const history = await readdir(join(dir, "history"));
        assert.equal(history.length, 1);
        assert.match(history[0], /^plan-\d{4}-\d{2}-\d{2}-\d{4}\.md$/);

        // A revised resubmission from the SAME session reuses the directory:
        // new history snapshot, plan.md overwritten, no sibling created.
        const again = await writePlanSubmission(root, "ses_a", "My Plan", "# body v2");
        assert.equal(again, "my-plan");
        assert.equal((await readFile(join(dir, "plan.md"), "utf8")).includes("# body v2"), true);
        assert.equal((await readdir(join(dir, "history"))).length, 2);
        const tasks = await readdir(join(root, ".lumina/tasks"));
        assert.deepEqual(tasks.sort(), ["my-plan"]);

        // A DIFFERENT session with the same title allocates its own dir.
        const other = await writePlanSubmission(root, "ses_b", "My Plan", "# other");
        assert.equal(other, "my-plan-2");
        assert.equal((await readFile(join(dir, "plan.md"), "utf8")).includes("# body v2"), true);
    });
});

test("writePlanSubmission self-heals a wiped directory", async () => {
    await withTempDir(async (root) => {
        await writePlanSubmission(root, "ses_a", "Rebuild Me", "# v1");
        await rm(join(root, ".lumina"), {recursive: true, force: true});
        const dirName = await writePlanSubmission(root, "ses_a", "Rebuild Me", "# v2");
        assert.equal(dirName, "rebuild-me");
        assert.match(await readFile(join(root, ".lumina/tasks/rebuild-me/plan.md"), "utf8"), /# v2/);
    });
});

test("writeTasksState refreshes tasks.md in the session's anchored directory", async () => {
    await withTempDir(async (root) => {
        await writePlanSubmission(root, "ses_a", "Plan X", "# body");
        const name = await writeTasksState(root, "ses_a", {
            title: "Plan X",
            items: [
                {title: "one", status: "completed"},
                {title: "two", status: "pending"},
            ],
        });
        assert.equal(name, "plan-x");
        const doc = await readFile(join(root, ".lumina/tasks/plan-x/tasks.md"), "utf8");
        assert.match(doc, /- \[x\] one/);
        assert.match(doc, /- \[ \] two/);
        // A session that never submitted gets a directory allocated rather
        // than drifting into another session's (executor call order makes
        // this unreachable in practice; the isolation still must hold).
        const nameB = await writeTasksState(root, "ses_b", {
            title: "Plan X",
            items: [{title: "one", status: "pending"}],
        });
        assert.equal(nameB, "plan-x-2");
    });
});

test("writeReportSubmission snapshots history and overwrites report.md", async () => {
    await withTempDir(async (root) => {
        await writePlanSubmission(root, "ses_a", "Plan X", "# body");
        const dirName = await writeReportSubmission(root, "ses_a", "Plan X", "All tests pass.");
        assert.equal(dirName, "plan-x");
        const dir = join(root, ".lumina/tasks/plan-x");
        const report = await readFile(join(dir, "report.md"), "utf8");
        assert.match(report, /^<!-- lumina: session=ses_a -->\n\nAll tests pass\.\n$/);
        assert.equal((await readdir(join(dir, "history"))).filter((n) => n.startsWith("report-")).length, 1);

        // A rejected-then-resubmitted report adds history, overwrites the newest.
        await writeReportSubmission(root, "ses_a", "Plan X", "Fixed the flaky test; all green.");
        assert.match(await readFile(join(dir, "report.md"), "utf8"), /flaky test/);
        assert.equal((await readdir(join(dir, "history"))).filter((n) => n.startsWith("report-")).length, 2);
    });
});

test("archiveTaskDirectory zips the complete record and removes the directory", async () => {
    await withTempDir(async (root) => {
        await writePlanSubmission(root, "ses_a", "Plan X", "# body");
        await writePlanSubmission(root, "ses_a", "Plan X", "# body v2"); // a second history snapshot
        await writeTasksState(root, "ses_a", {
            title: "Plan X",
            items: [
                {title: "one", status: "completed"},
                {title: "two", status: "completed"},
            ],
        });
        await writeReportSubmission(root, "ses_a", "Plan X", "Verified by hand.");

        const result = await archiveTaskDirectory(root, "ses_a", "Plan X");
        assert.equal(result.error, undefined);
        assert.equal(result.zipName, "plan-x.zip");
        assert.equal(result.path, join(root, ".lumina/archived/plan-x.zip"));
        // The task directory is gone; the archive stands.
        const tasks = await readdir(join(root, ".lumina/tasks"));
        assert.equal(tasks.includes("plan-x"), false);
        const zipBytes = await readFile(join(root, ".lumina/archived/plan-x.zip"));
        // Python-side extraction is asserted in the live manual check; here
        // verify the stored archive parses and carries every member.
        const text = zipBytes.toString("latin1");
        assert.equal(text.includes("plan.md"), true);
        assert.equal(text.includes("history/plan-"), true);

        // A second archive of the same title (new session, new dir) gets -2.
        await writePlanSubmission(root, "ses_b", "Plan X", "# redo");
        await writeTasksState(root, "ses_b", {title: "Plan X", items: [{title: "one", status: "completed"}]});
        await writeReportSubmission(root, "ses_b", "Plan X", "Again.");
        const again = await archiveTaskDirectory(root, "ses_b", "Plan X");
        assert.equal(again.zipName, "plan-x-2.zip");
    });
});

test("sweepOrphanAcceptance archives on an unconsumed marker and never touches a claimed gate", async () => {
    await withTempDir(async (root) => {
        const sid = "ses_sweep";
        // An approved plan on disk (submission + tasks.md + report).
        await writePlanSubmission(root, sid, "Sweep Plan", "# body");
        await writeTasksState(root, sid, {
            title: "Sweep Plan",
            items: [{title: "only", status: "completed"}],
        });
        await writeReportSubmission(root, sid, "Sweep Plan", "Done.");
        // The acceptance marker a dead executor never consumed.
        const {mkdir, writeFile} = await import("node:fs/promises");
        await mkdir(join(root, ".lumina/review"), {recursive: true});
        const marker = join(root, ".lumina/review", `${sid}.json`);
        await writeFile(marker, JSON.stringify({approved: true, at: "2026-09-30T00:00:00Z"}));
        // The fake host ctx: session.get resolves the directory, context
        // returns the transcript the fold reads the title from.
        const ctx = {
            session: {
                get: async () => ({location: {directory: root}}),
                context: async () => [
                    {
                        parts: [
                            {
                                type: "tool",
                                name: "plan_submit",
                                state: {status: "completed", input: {title: "Sweep Plan", todos: ["only"]}},
                            },
                        ],
                    },
                ],
            },
        };

        await sweepOrphanAcceptance(ctx, sid, "build");
        // The plan archived and the marker consumed.
        assert.equal((await readdir(join(root, ".lumina/archived"))).includes("sweep-plan.zip"), true);
        assert.equal((await readdir(join(root, ".lumina/tasks"))).includes("sweep-plan"), false);
        await assert.rejects(() => readFile(marker));

        // With a LIVE gate claimed, the sweep leaves the channel alone:
        // a fresh marker stays until the gate consumes it.
        await writePlanSubmission(root, sid, "Sweep Plan", "# v2");
        await writeFile(marker, JSON.stringify({approved: true}));
        const gen = claimGate(sid);
        await sweepOrphanAcceptance(ctx, sid, "build");
        assert.ok(gateIsCurrent(sid, gen));
        const tasks = await readdir(join(root, ".lumina/tasks"));
        assert.equal(tasks.includes("sweep-plan"), true, "the claimed gate's directory was not archived");
        await assert.doesNotReject(() => readFile(marker), "the claimed gate's marker was not consumed");
    });
});

// --- stall detection (the anti-loop runtime half) ---

/** One assistant message with tool parts, the session.context shape. */
function step(parts) {
    return {info: {role: "assistant"}, parts};
}
function toolPart(name, status, error) {
    return {type: "tool", name, state: status ? {status, error} : {status}};
}

test("errorFingerprint folds numbers/hex/dirs but keeps file names", () => {
    assert.equal(
        errorFingerprint("ENOENT: no such file /home/me/src/a.ts at line 42"),
        errorFingerprint("ENOENT: no such file /you/other/place/src/a.ts at line 97"),
    );
    // Different file names stay different errors.
    assert.notEqual(
        errorFingerprint("File not found: /x/a.ts"),
        errorFingerprint("File not found: /x/b.ts"),
    );
    assert.equal(errorFingerprint(null), "");
    assert.equal(errorFingerprint("  "), "");
});

test("collectStallSignals flags the same error twice", () => {
    const messages = [
        step([toolPart("bash", "error", "exit 1: make error at /src/a.ts:10")]),
        step([toolPart("edit", "completed")]),
        step([toolPart("bash", "error", "exit 1: make error at /src/a.ts:99")]),
    ];
    const signals = collectStallSignals(messages);
    assert.ok(signals.repeatedError);
    // A DIFFERENT error after the first resets the pair.
    const varied = [
        step([toolPart("bash", "error", "make error /src/a.ts:1")]),
        step([toolPart("bash", "error", "make error /src/b.ts:1")]),
    ];
    assert.equal(collectStallSignals(varied).repeatedError, null);
});

test("collectStallSignals flags inspection-only loops, not prose or fresh reads", () => {
    // Three trailing read-only steps with calls → stagnant.
    const looping = [
        step([toolPart("edit", "completed")]),
        step([toolPart("read", "completed")]),
        step([toolPart("grep", "completed")]),
        step([toolPart("read", "completed")]),
    ];
    assert.equal(collectStallSignals(looping).stagnantSteps, 3);
    // Pure prose answers are conversations, not loops.
    const prose = [step([]), step([]), step([]), step([])];
    assert.equal(collectStallSignals(prose).stagnantSteps, 0);
    // Trailing steps without tool calls break the streak.
    const mixed = [step([toolPart("read", "completed")]), step([]), step([])];
    assert.equal(collectStallSignals(mixed).stagnantSteps, 0);
    // An edit anywhere in the trailing run resets the count.
    const resolved = [
        step([toolPart("read", "completed")]),
        step([toolPart("read", "completed")]),
        step([toolPart("edit", "completed")]),
    ];
    assert.equal(collectStallSignals(resolved).stagnantSteps, 0);
});

test("renderStallWarning gates the inspection warning to build only", () => {
    const signals = {repeatedError: null, stagnantSteps: 4};
    assert.ok(renderStallWarning(signals, "build"));
    assert.equal(renderStallWarning(signals, "lumina-daily"), null);
    // Repeated errors warn on every execution agent.
    const err = {repeatedError: "make error a.ts:n", stagnantSteps: 0};
    assert.ok(renderStallWarning(err, "build"));
    assert.ok(renderStallWarning(err, "lumina-daily"));
    assert.equal(renderStallWarning({repeatedError: null, stagnantSteps: 0}, "build"), null);
});

// --- tool discovery (search_tools' pure halves) ---

test("filterToolGuides matches tokens and falls back to the catalog", async () => {
    const {filterToolGuides, TOOL_GUIDES} = await import("./luminaTools.js");
    // A terminal-ish query finds the bash guide.
    assert.equal(filterToolGuides(TOOL_GUIDES, "run a command").length, 1);
    assert.equal(filterToolGuides(TOOL_GUIDES, "terminal").length, 1);
    // Unmatched query → no guides.
    assert.equal(filterToolGuides(TOOL_GUIDES, "pdf").length, 0);
    // Empty query → the whole catalog.
    assert.equal(filterToolGuides(TOOL_GUIDES, "").length, TOOL_GUIDES.length);
    assert.equal(filterToolGuides(TOOL_GUIDES, null).length, TOOL_GUIDES.length);
});

// --- configGuideFor (on-demand MCP/plugin guides) -------------------------

/** A session.context-shaped transcript: {info: {role}, parts: [{type, text}]}. */
const transcript = (...turns) =>
    turns.map(([role, text]) => ({info: {role}, parts: [{type: "text", text}]}));

test("configGuideFor injects the MCP guide on MCP asks (zh + en)", () => {
    const zh = transcript(["user", "帮我加一个天气 MCP 服务器"], ["assistant", "好的"]);
    const en = transcript(["user", "can you set up an MCP server for search?"]);
    assert.match(configGuideFor(zh), /mcp\.servers/);
    assert.match(configGuideFor(en), /mcp\.servers/);
    // The full protocol name counts too.
    assert.match(
        configGuideFor(transcript(["user", "how do I use Model Context Protocol here?"])),
        /mcp\.servers/,
    );
});

test("configGuideFor needs an action verb for plugin asks", () => {
    // Bare plugin chatter (development talk) → no guide.
    assert.equal(configGuideFor(transcript(["user", "the plugin system in this codebase is neat"])), "");
    // With an action verb → the plugin guide.
    assert.match(configGuideFor(transcript(["user", "帮我安装一个翻译插件"])), /"plugins" array/);
    assert.match(configGuideFor(transcript(["user", "install the github plugin please"])), /"plugins" array/);
    // 扩展 counts as the plugin term.
    assert.match(configGuideFor(transcript(["user", "配置一个扩展"])), /"plugins" array/);
});

test("configGuideFor short-circuits expanded managed commands and quiet topics", () => {
    // An expanded /mcp command message: starts with the managed mark —
    // the template already carries the full manual, no duplicate guide.
    const expanded = transcript(["user", "<!-- managed by Lumina Code -->\nCurrent global config…"]);
    assert.equal(configGuideFor(expanded), "");
    // Unrelated topic → "".
    assert.equal(configGuideFor(transcript(["user", "写一份周报"])), "");
    // Only the LATEST user message decides (an earlier MCP ask has ended).
    const movedOn = transcript(
        ["user", "add an mcp server"],
        ["assistant", "done"],
        ["user", "thanks, now write a summary"],
    );
    assert.equal(configGuideFor(movedOn), "");
});

test("configGuideFor tolerates empty and degraded transcripts", () => {
    assert.equal(configGuideFor([]), "");
    assert.equal(configGuideFor(null), "");
    assert.equal(configGuideFor([{info: {role: "assistant"}, parts: []}]), "");
    // Degraded shapes (no parts / non-array) never throw.
    assert.equal(configGuideFor([{info: {role: "user"}}]), "");
    assert.equal(configGuideFor([{info: {role: "user"}, parts: null}]), "");
});
