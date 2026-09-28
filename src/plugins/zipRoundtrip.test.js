// Round-trip the plan archive: the PLUGIN's buildStoredZip writes, the
// frontend's lib/zipReader.ts reads back. The plugin file is plain ESM
// JS and the reader is TS — node's type stripping loads both from this
// .js test (same pattern as luminaTools.test.js).
import assert from "node:assert/strict";
import {test} from "node:test";
import {readStoredZipEntry} from "../lib/zipReader.ts";
import {buildStoredZip} from "./luminaTools.js";

test("readStoredZipEntry round-trips every member the archive writes", () => {
    const zip = buildStoredZip(
        [
            {name: "plan.md", content: "<!-- lumina: session=ses_a -->\n\n# 计划\n"},
            {name: "report.md", content: "All good."},
            {name: "tasks.md", content: "- [x] done"},
            {name: "history/plan-2026-09-28-1010.md", content: "v1"},
        ],
        new Date(2026, 8, 28, 10, 10),
    );
    assert.equal(readStoredZipEntry(zip, "plan.md"), "<!-- lumina: session=ses_a -->\n\n# 计划\n");
    assert.equal(readStoredZipEntry(zip, "report.md"), "All good.");
    assert.equal(readStoredZipEntry(zip, "history/plan-2026-09-28-1010.md"), "v1");
    // Absent names and directories read as null.
    assert.equal(readStoredZipEntry(zip, "nope.md"), null);
    assert.equal(readStoredZipEntry(zip, "history"), null);
});

test("readStoredZipEntry refuses garbage bytes", () => {
    assert.equal(readStoredZipEntry(new Uint8Array([1, 2, 3]), "plan.md"), null);
    assert.equal(readStoredZipEntry(new TextEncoder().encode("not a zip at all"), "x"), null);
});

test("findSessionArchive claims the anchored zip among collisions", async () => {
    const {findSessionArchive} = await import("../opencode/planDocuments.ts");
    // Two same-slug archives: the bare one belongs to ANOTHER session.
    const theirs = buildStoredZip([{name: "plan.md", content: "<!-- lumina: session=ses_OTHER -->\n\n# x\n"}], new Date());
    const ours = buildStoredZip(
        [
            {name: "plan.md", content: "<!-- lumina: session=ses_mine -->\n\n# 我的计划\n"},
            {name: "report.md", content: "验收通过。"},
        ],
        new Date(),
    );
    const files = new Map([
        [".lumina/archived/my-plan.zip", theirs],
        [".lumina/archived/my-plan-2.zip", ours],
    ]);
    const fakeApi = {
        readFileBlob: async (dir, name) => {
            const bytes = files.get(name);
            return bytes ? new Blob([bytes]) : null;
        },
    };
    const archive = await findSessionArchive(fakeApi, "/w", "ses_mine", "My Plan");
    assert.notEqual(archive, null);
    assert.match(archive.read("plan.md"), /我的计划/);
    assert.equal(archive.read("report.md"), "验收通过。");
    // No anchored archive → null (and a report-only reader never forms).
    assert.equal(await findSessionArchive(fakeApi, "/w", "ses_gone", "My Plan"), null);
});
