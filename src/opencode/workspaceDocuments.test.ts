import test from "node:test";
import assert from "node:assert/strict";
import type {DocRow} from "./workspaceDocuments.ts";

/**
 * The workspace-documents scan's pure halves (the sessionActivity
 * pattern): wc parsing, the rolling-baseline diff, presentation order
 * and the human sizes.
 */
const {
    parseSizeLines,
    diffDocs,
    sortDocRows,
    humanSize,
    posixScanCommand,
    powershellScanCommand,
    filterSeedDocuments,
    filterSessionMarkers,
    MAX_DOC_ROWS,
} = await import("./workspaceDocuments.ts");

test("parseSizeLines: one size+path per line, noise dropped", () => {
    const out = [
        "  1204 /home/u/Documents/LuminaWorkspace/报告.docx",
        "     0 /home/u/Documents/LuminaWorkspace/空 文件.txt", // spaces stay intact
        "  1204 total", // wc's per-batch total (bare / "total" suffix)
        "",
        "\r",
        "garbage without digits",
    ].join("\n");
    assert.deepEqual(parseSizeLines(out), [
        {size: 1204, path: "/home/u/Documents/LuminaWorkspace/报告.docx"},
        {size: 0, path: "/home/u/Documents/LuminaWorkspace/空 文件.txt"},
    ]);
});

test("parseSizeLines: the LOCALIZED wc total row is dropped (zh_CN '总计')", () => {
    // wc localizes its per-batch summary label; the panel must not turn
    // it into a file row (live-observed on a zh_CN machine).
    const out = [
        "  1204 /home/u/Documents/LuminaWorkspace/报告.docx",
        " 11298 总计",
    ].join("\n");
    assert.deepEqual(parseSizeLines(out), [
        {size: 1204, path: "/home/u/Documents/LuminaWorkspace/报告.docx"},
    ]);
});

test("parseSizeLines: PowerShell output parses the same way (CRLF)", () => {
    const out = "12 C:/Users/u/Documents/LuminaWorkspace/a.md\r\n34 C:/Users/u/Documents/LuminaWorkspace/b.pptx\r\n";
    assert.deepEqual(parseSizeLines(out).map((d) => d.size), [12, 34]);
});

test("parseSizeLines caps the row count", () => {
    const out = Array.from({length: MAX_DOC_ROWS + 50}, (_, i) => `${i} /ws/f${i}`).join("\n");
    assert.equal(parseSizeLines(out).length, MAX_DOC_ROWS);
});

test("diffDocs: null baseline is the plain inventory (nothing 'new')", () => {
    const next = [{path: "/w/a", size: 1}, {path: "/w/b", size: 2}];
    assert.deepEqual(diffDocs(null, next), [
        {path: "/w/a", size: 1, change: null},
        {path: "/w/b", size: 2, change: null},
    ]);
});

test("diffDocs: new/changed/unchanged against the previous scan", () => {
    const prev = [{path: "/w/old.md", size: 10}, {path: "/w/报告.docx", size: 100}];
    const next = [
        {path: "/w/old.md", size: 10}, // untouched
        {path: "/w/报告.docx", size: 340}, // rewritten (size moved)
        {path: "/w/新.pptx", size: 5}, // born this run
    ];
    const rows = diffDocs(prev, next);
    assert.deepEqual(rows.find((r) => r.path.endsWith("old.md"))?.change, null);
    assert.deepEqual(rows.find((r) => r.path.endsWith("报告.docx"))?.change, "changed");
    assert.deepEqual(rows.find((r) => r.path.endsWith("新.pptx"))?.change, "new");
});

test("diffDocs: deleted files simply drop off (no tombstones)", () => {
    const rows = diffDocs([{path: "/w/gone", size: 1}], [{path: "/w/stays", size: 1}]);
    assert.deepEqual(rows.map((r) => r.path), ["/w/stays"]);
});

test("sortDocRows: new first, then changed, then the rest by path", () => {
    const rows: DocRow[] = [
        {path: "/w/b", size: 1, change: null},
        {path: "/w/z-new", size: 1, change: "new"},
        {path: "/w/a-changed", size: 1, change: "changed"},
        {path: "/w/a", size: 1, change: null},
        {path: "/w/0-new", size: 1, change: "new"},
    ];
    assert.deepEqual(sortDocRows(rows).map((r) => r.path), [
        "/w/0-new",
        "/w/z-new",
        "/w/a-changed",
        "/w/a",
        "/w/b",
    ]);
});

test("humanSize tiers with one decimal under 10", () => {
    assert.equal(humanSize(0), "0 B");
    assert.equal(humanSize(999), "999 B");
    assert.equal(humanSize(1024), "1.0 KB");
    assert.equal(humanSize(12 * 1024), "12 KB");
    assert.equal(humanSize(1.5 * 1024 * 1024), "1.5 MB");
    assert.equal(humanSize(3 * 1024 * 1024 * 1024), "3.0 GB");
});

test("filterSeedDocuments: the app's root seed files drop, subfolder READMEs stay", () => {
    const dir = "/home/u/Documents/LuminaWorkspace";
    const docs = [
        {path: `${dir}/README.md`, size: 193},
        {path: `${dir}/AGENTS.md`, size: 551},
        {path: `${dir}/随笔.docx`, size: 10554},
        {path: `${dir}/资料/README.md`, size: 40}, // the user's own — stays
    ];
    assert.deepEqual(
        filterSeedDocuments(docs, dir).map((d) => d.path),
        [`${dir}/随笔.docx`, `${dir}/资料/README.md`],
    );
    // Trailing slash on the directory and Windows separators (the
    // PowerShell fallback prints FullName with backslashes) both match.
    assert.deepEqual(filterSeedDocuments([{path: "C:/w/README.md", size: 1}], "C:/w/"), []);
    assert.deepEqual(filterSeedDocuments([{path: "C:\\w\\AGENTS.md", size: 1}], "C:/w"), []);
    assert.deepEqual(filterSeedDocuments([{path: "C:\\w\\keep.docx", size: 1}], "C:/w").length, 1);
});

test("scan commands quote the directory once", () => {
    assert.equal(
        posixScanCommand("/home/u/Work Space"),
        `find '/home/u/Work Space' -type f -not -path '*/.*'` +
            ` -not -path '/home/u/Work Space/Sessions/*' -exec wc -c {} +`,
    );
    assert.equal(
        powershellScanCommand("/home/u/Work Space"),
        `Get-ChildItem -Recurse -File -Path '/home/u/Work Space'` +
            ` | Where-Object { $_.FullName -notlike '/home/u/Work Space/Sessions/*'` +
            ` -and $_.FullName -notlike '\\home\\u\\Work Space\\Sessions\\*' }` +
            ` | ForEach-Object { '{0} {1}' -f $_.Length, $_.FullName }`,
    );
    // Apostrophes survive the POSIX splice idiom.
    assert.ok(posixScanCommand("/home/u/it's").includes(`'/home/u/it'\\''s'`));
});

test("scan commands tolerate a trailing slash on the directory (no //Sessions pattern)", () => {
    // find's -path is a LITERAL match — '/w//Sessions/*' would never
    // hit the real '/w/Sessions/x', silently un-excluding the container.
    assert.ok(posixScanCommand("/home/u/w/").includes(`-not -path '/home/u/w/Sessions/*'`));
});

test("filterSessionMarkers drops the hidden claim file at any depth, both separators", () => {
    const docs = [
        {path: "/w/Sessions/周报/.lumina-session.json", size: 60},
        {path: "/w/资料\\.lumina-session.json", size: 60}, // PowerShell FullName form
        {path: "/w/Sessions/周报/报告.docx", size: 10554},
        {path: "/w/随手记.md", size: 40},
    ];
    assert.deepEqual(
        filterSessionMarkers(docs).map((d) => d.path),
        ["/w/Sessions/周报/报告.docx", "/w/随手记.md"],
    );
});
