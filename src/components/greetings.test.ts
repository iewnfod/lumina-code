import assert from "node:assert/strict";
import {test} from "node:test";
import {pickGreeting} from "./greetings.ts";

/** rng stub that replays the given rolls, clamping to the last one. */
function rng(...rolls: number[]): () => number {
    let i = 0;
    return () => rolls[Math.min(i++, rolls.length - 1)];
}

// 2026 anchors: Sep 17 Thu, Sep 18 Fri, Sep 19 Sat, Sep 21 Mon, Sep 22 Tue,
// Oct 22 Thu, Oct 24 Sat.
const at = (month: number, day: number, hour: number, minute = 0) =>
    new Date(2026, month, day, hour, minute);

test("crazy Thursday fires in the meal window for zh, not for en", () => {
    const thursdayLunch = at(8, 17, 12, 0);
    // zh: gate passes (0 < 0.3); the pool holds a single text, so any
    // index roll picks it.
    assert.equal(
        pickGreeting({now: thursdayLunch, language: "zh-cn", projectName: null, random: rng(0, 0)}),
        "今天疯狂星期四，V我50，我告诉你 bug 在哪",
    );
    assert.equal(
        pickGreeting({now: thursdayLunch, language: "zh-cn", projectName: null, random: rng(0, 0.7)}),
        "今天疯狂星期四，V我50，我告诉你 bug 在哪",
    );
    // zh: gate fails (0.9 >= 0.3) → plain afternoon.
    assert.equal(
        pickGreeting({now: thursdayLunch, language: "zh-cn", projectName: null, random: rng(0.9)}),
        "下午好呀，今天需要我帮忙做什么呀",
    );
    // en: no Thursday texts → falls straight to the fun pool (no KFC leak).
    assert.equal(
        pickGreeting({now: thursdayLunch, language: "en-us", projectName: null, random: rng(0, 0)}),
        "Where should we begin?",
    );
});

test("Thursday outside the meal windows is a normal day", () => {
    assert.equal(
        pickGreeting({now: at(8, 17, 14, 30), language: "zh-cn", projectName: null, random: rng(0, 0)}),
        "我们从哪里开始？",
    );
});

test("Oct 24 always wins, even against the weekend window and a maxed roll", () => {
    const programmersDay = at(9, 24, 15, 0); // Saturday afternoon
    assert.equal(
        pickGreeting({now: programmersDay, language: "zh-cn", projectName: null, random: rng(0.99, 0.99)}),
        "1024 程序员节快乐，愿你写的代码永无 bug",
    );
    assert.equal(
        pickGreeting({now: programmersDay, language: "en-us", projectName: null, random: rng(0.99, 0.99)}),
        "Happy 1024, fellow programmer.",
    );
});

test("late night fires and falls back to the plain night greeting", () => {
    const weeHours = at(8, 22, 3, 0); // Tuesday 03:00
    assert.equal(
        pickGreeting({now: weeHours, language: "zh-cn", projectName: null, random: rng(0, 0)}),
        "这个点了还在写代码？bug 都替你困了...",
    );
    assert.equal(
        pickGreeting({now: weeHours, language: "en-us", projectName: null, random: rng(0, 0)}),
        "Writing code at this hour? Even the bugs are sleepy.",
    );
    assert.equal(
        pickGreeting({now: weeHours, language: "zh-cn", projectName: null, random: rng(0.9)}),
        "夜深了，早点休息呀",
    );
});

test("Friday afternoon warns about deploys; Friday morning does not", () => {
    assert.equal(
        pickGreeting({now: at(8, 18, 15, 0), language: "zh-cn", projectName: null, random: rng(0, 0)}),
        "周五不宜部署，宜摸鱼~",
    );
    assert.equal(
        pickGreeting({now: at(8, 18, 15, 0), language: "en-us", projectName: null, random: rng(0, 0)}),
        "Friday. Maybe don't deploy today.",
    );
    assert.equal(
        pickGreeting({now: at(8, 18, 10, 0), language: "zh-cn", projectName: null, random: rng(0, 0)}),
        "我们从哪里开始？",
    );
});

test("Monday morning fires", () => {
    assert.equal(
        pickGreeting({now: at(8, 21, 8, 0), language: "zh-cn", projectName: null, random: rng(0, 0)}),
        "周一了，先把编译跑绿，再把人生跑绿",
    );
});

test("weekend daytime fires and falls back to the plain greeting", () => {
    assert.equal(
        pickGreeting({now: at(8, 19, 14, 0), language: "zh-cn", projectName: null, random: rng(0, 0)}),
        "周末写代码，是热爱，还是 deadline？",
    );
    assert.equal(
        pickGreeting({now: at(8, 19, 14, 0), language: "zh-cn", projectName: null, random: rng(0.9)}),
        "下午好呀，今天需要我帮忙做什么呀",
    );
});

test("fun pool interpolates {project}", () => {
    const tuesdayMorning = at(8, 22, 10, 0);
    assert.equal(
        pickGreeting({now: tuesdayMorning, language: "en-us", projectName: "lumina-code", random: rng(0.1, 0.1)}),
        "What should we build in lumina-code?",
    );
    assert.equal(
        pickGreeting({now: tuesdayMorning, language: "zh-cn", projectName: "lumina-code", random: rng(0.1, 0.15)}),
        "想在 lumina-code 里构建点什么？",
    );
});

test("fun pool skips {project} entries when no directory is selected", () => {
    // With the {project} entry filtered out, roll 0.1 lands on the next
    // candidate ("What are we building?") instead of a dangling placeholder.
    assert.equal(
        pickGreeting({now: at(8, 22, 10, 0), language: "en-us", projectName: null, random: rng(0.1, 0.1)}),
        "What are we building?",
    );
});

test("plain greetings cover the four time-of-day tiers", () => {
    const zh = (hour: number) =>
        pickGreeting({now: at(8, 22, hour), language: "zh-cn", projectName: null, random: rng(0.99)});
    assert.equal(zh(8), "早上好呀，新的一天一起加油");
    assert.equal(zh(14), "下午好呀，今天需要我帮忙做什么呀");
    assert.equal(zh(19), "晚上好呀，今天辛苦啦");
    assert.equal(zh(23), "夜深了，早点休息呀");
    assert.equal(zh(3), "夜深了，早点休息呀");
    assert.equal(
        pickGreeting({now: at(8, 22, 8), language: "en-us", projectName: null, random: rng(0.99)}),
        "Good morning",
    );
});
