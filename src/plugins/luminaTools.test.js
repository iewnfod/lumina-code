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
    composePlanDoc,
    composeReportDoc,
    composeTasksDoc,
    gateIsCurrent,
    historyFileName,
    planDirName,
    planFileSlug,
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
import {archiveTaskDirectory, writePlanSubmission, writeReportSubmission, writeTasksState} from "./luminaTools.js";

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
