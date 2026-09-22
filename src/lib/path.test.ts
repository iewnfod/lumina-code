import assert from "node:assert/strict";
import {test} from "node:test";
import {displayPath, folderLabel} from "./path.ts";

test("folderLabel takes the last segment", () => {
    assert.equal(folderLabel("/home/user/proj"), "proj");
    assert.equal(folderLabel("/home/user/proj/"), "proj");
    assert.equal(folderLabel("C:\\dev\\proj\\"), "proj");
});

test("folderLabel falls back to the input on separator-only paths", () => {
    assert.equal(folderLabel("/"), "/");
    assert.equal(folderLabel("///"), "///");
});

test("displayPath relativizes absolute paths inside the project", () => {
    assert.equal(displayPath("/home/user/proj/src/a.ts", "/home/user/proj"), "src/a.ts");
    assert.equal(displayPath("/home/user/proj", "/home/user/proj"), ".");
    assert.equal(displayPath("/home/user/proj/", "/home/user/proj/"), ".");
});

test("displayPath keeps outside-absolute paths untouched", () => {
    assert.equal(displayPath("/etc/passwd", "/home/user/proj"), "/etc/passwd");
});

test("displayPath passes non-absolute inputs through", () => {
    assert.equal(displayPath("src/a.ts", "/home/user/proj"), "src/a.ts");
    assert.equal(displayPath("https://x/y", "/home/user/proj"), "https://x/y");
    assert.equal(displayPath("*.ts", "/home/user/proj"), "*.ts");
    assert.equal(displayPath("a.ts", null), "a.ts");
});

test("displayPath handles windows separators", () => {
    assert.equal(displayPath("C:\\dev\\proj\\src\\a.ts", "C:\\dev\\proj"), "src\\a.ts");
    assert.equal(displayPath("C:\\other\\a.ts", "C:\\dev\\proj"), "C:\\other\\a.ts");
});
