import assert from "node:assert/strict";
import {test} from "node:test";
import {composePlanDocument, planFileName, planFileSlug} from "./planFiles.ts";

const NOW = new Date(2026, 8, 25, 14, 30); // 2026-09-25, local fields only

test("planFileSlug keeps unicode letters and digits, collapses the rest", () => {
    assert.equal(planFileSlug("Add Todo Workflow!"), "add-todo-workflow");
    assert.equal(planFileSlug("重构  计划——v2"), "重构-计划-v2");
    assert.equal(planFileSlug("  --It's a  PLAN--  "), "its-a-plan");
    assert.equal(planFileSlug("!!!"), "plan"); // nothing left → fallback
    assert.equal(planFileSlug(""), "plan");
});

test("planFileSlug caps long titles without trailing dashes", () => {
    const slug = planFileSlug("a".repeat(100));
    assert.equal(slug.length, 60);
    assert.match(slug, /^a+$/);
});

test("planFileName dates, slugs and disambiguates collisions", async () => {
    const taken = new Set(["2026-09-25-add-todo.md"]);
    assert.equal(await planFileName("Add Todo", NOW, () => false), "2026-09-25-add-todo.md");
    assert.equal(await planFileName("Add Todo", NOW, (n) => taken.has(n)), "2026-09-25-add-todo-2.md");
    const more = new Set(["2026-09-25-add-todo.md", "2026-09-25-add-todo-2.md"]);
    assert.equal(await planFileName("Add Todo", NOW, (n) => more.has(n)), "2026-09-25-add-todo-3.md");
    // Async probes (the fs/read round-trip) work the same.
    assert.equal(
        await planFileName("Add Todo", NOW, async (n) => taken.has(n)),
        "2026-09-25-add-todo-2.md",
    );
});

test("composePlanDocument embeds the plan and the live checklist", () => {
    const doc = composePlanDocument(
        "Plan A",
        "# Plan A\n\nBody text.",
        [
            {title: "one", status: "completed"},
            {title: "two", status: "blocked", reason: "missing dep"},
            {title: "three", status: "pending"},
        ],
    );
    assert.match(doc, /^# Plan A\n\n# Plan A\n\nBody text\.\n\n---\n\n## Tasks\n\n/);
    assert.match(doc, /1\. \[x\] one/);
    assert.match(doc, /2\. \[!\] two — blocked: missing dep/);
    assert.match(doc, /3\. \[ \] three/);
});
