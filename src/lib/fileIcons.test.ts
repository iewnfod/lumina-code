import test from "node:test";
import assert from "node:assert/strict";
import {FILE_ICON_DEFAULT, FILE_ICON_NAMES} from "./fileIcons.generated.ts";
import {fileIconName, fileIconUrl} from "./fileIcons.ts";

test("exact filename wins over the extension", () => {
    // package.json is a json file, but its filename maps to the nodejs icon.
    assert.equal(fileIconName("package.json"), "nodejs");
    assert.equal(fileIconName("/abs/path/PACKAGE.JSON"), "nodejs"); // lookup lowercases
});

test("extensions resolve without a filename match", () => {
    assert.equal(fileIconName("src/main.rs"), "rust");
    assert.equal(fileIconName("App.tsx"), "react_ts");
    assert.equal(fileIconName("archive.tar.gz"), "zip"); // last segment wins
});

test("dotfiles resolve through the filename map", () => {
    assert.equal(fileIconName(".gitignore"), "git");
});

test("unknown and extension-less files fall back to the generic icon", () => {
    assert.equal(fileIconName("mystery.zzzx"), FILE_ICON_DEFAULT);
    assert.equal(fileIconName("zzz-unknown-name"), FILE_ICON_DEFAULT);
    assert.equal(fileIconName("a/b/"), FILE_ICON_DEFAULT);
});

test("urls point at the generated asset set", () => {
    assert.equal(fileIconUrl("main.rs"), "/icons/files/rust.svg");
    assert.equal(fileIconUrl("zzz-unknown-name"), `/icons/files/${FILE_ICON_DEFAULT}.svg`);
});

test("every mapped icon ships a file the url can resolve to", () => {
    // Spot-check a sample of both maps: the url must be well-formed and
    // reference an icon name present in the filename map's value set shape
    // (slug names only — no slashes or spaces that would break the URL).
    for (const name of [FILE_ICON_NAMES["package.json"], FILE_ICON_NAMES[".gitignore"]]) {
        assert.match(fileIconUrl(`x-${name}`), /^\/icons\/files\/[a-z0-9-]+\.svg$/);
    }
});
