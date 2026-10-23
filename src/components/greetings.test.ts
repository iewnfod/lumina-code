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

// --- dev mode (the original coder-flavored pools) ---

test("crazy Thursday fires in the meal window for zh, not for en", () => {
    const thursdayLunch = at(8, 17, 12, 0);
    // zh: gate passes (0 < 0.3); the pool holds a single text, so any
    // index roll picks it.
    assert.equal(
        pickGreeting({now: thursdayLunch, language: "zh-cn", mode: "dev", projectName: null, random: rng(0, 0)}),
        "今天疯狂星期四，V我50，我告诉你 bug 在哪",
    );
    assert.equal(
        pickGreeting({now: thursdayLunch, language: "zh-cn", mode: "dev", projectName: null, random: rng(0, 0.7)}),
        "今天疯狂星期四，V我50，我告诉你 bug 在哪",
    );
    // zh: gate fails (0.9 >= 0.3) → plain afternoon.
    assert.equal(
        pickGreeting({now: thursdayLunch, language: "zh-cn", mode: "dev", projectName: null, random: rng(0.9)}),
        "下午好呀，今天需要我帮忙做什么呀",
    );
    // en: no Thursday texts → falls straight to the fun pool (no KFC leak).
    assert.equal(
        pickGreeting({now: thursdayLunch, language: "en-us", mode: "dev", projectName: null, random: rng(0, 0)}),
        "Where shall we begin?",
    );
});

test("Thursday outside the meal windows is a normal day", () => {
    assert.equal(
        pickGreeting({now: at(8, 17, 14, 30), language: "zh-cn", mode: "dev", projectName: null, random: rng(0, 0)}),
        "我们从哪里开始？",
    );
});

test("Oct 24 always wins in dev, even against the weekend window and a maxed roll", () => {
    const programmersDay = at(9, 24, 15, 0); // Saturday afternoon
    assert.equal(
        pickGreeting({now: programmersDay, language: "zh-cn", mode: "dev", projectName: null, random: rng(0.99, 0.99)}),
        "1024 程序员节快乐，愿你写的代码永无 bug",
    );
    assert.equal(
        pickGreeting({now: programmersDay, language: "en-us", mode: "dev", projectName: null, random: rng(0.99, 0.99)}),
        "Happy 1024. Wish there's no bug in your code.",
    );
});

test("late night fires and falls back to the plain night greeting", () => {
    const weeHours = at(8, 22, 3, 0); // Tuesday 03:00
    assert.equal(
        pickGreeting({now: weeHours, language: "zh-cn", mode: "dev", projectName: null, random: rng(0, 0)}),
        "这个点了还在写代码？bug 都替你困了...",
    );
    assert.equal(
        pickGreeting({now: weeHours, language: "en-us", mode: "dev", projectName: null, random: rng(0, 0)}),
        "Writing code at this hour? Even the bugs are sleepy.",
    );
    assert.equal(
        pickGreeting({now: weeHours, language: "zh-cn", mode: "dev", projectName: null, random: rng(0.9)}),
        "夜深了，早点休息呀",
    );
});

test("Friday afternoon warns about deploys; Friday morning does not", () => {
    assert.equal(
        pickGreeting({now: at(8, 18, 15, 0), language: "zh-cn", mode: "dev", projectName: null, random: rng(0, 0)}),
        "周五不宜部署，宜摸鱼~",
    );
    assert.equal(
        pickGreeting({now: at(8, 18, 15, 0), language: "en-us", mode: "dev", projectName: null, random: rng(0, 0)}),
        "Friday. Deploy less, slack more.",
    );
    assert.equal(
        pickGreeting({now: at(8, 18, 10, 0), language: "zh-cn", mode: "dev", projectName: null, random: rng(0, 0)}),
        "我们从哪里开始？",
    );
});

test("Monday morning fires", () => {
    assert.equal(
        pickGreeting({now: at(8, 21, 8, 0), language: "zh-cn", mode: "dev", projectName: null, random: rng(0, 0)}),
        "周一了，先把编译跑绿，再把人生跑绿",
    );
});

test("weekend daytime fires and falls back to the plain greeting", () => {
    assert.equal(
        pickGreeting({now: at(8, 19, 14, 0), language: "zh-cn", mode: "dev", projectName: null, random: rng(0, 0)}),
        "周末写代码，是热爱，还是最后期限到了？",
    );
    assert.equal(
        pickGreeting({now: at(8, 19, 14, 0), language: "zh-cn", mode: "dev", projectName: null, random: rng(0.9)}),
        "下午好呀，今天需要我帮忙做什么呀",
    );
});

test("fun pool interpolates {project}", () => {
    const tuesdayMorning = at(8, 22, 10, 0);
    assert.equal(
        pickGreeting({now: tuesdayMorning, language: "en-us", mode: "dev", projectName: "lumina-code", random: rng(0.1, 0.1)}),
        "What shall we build in lumina-code?",
    );
    assert.equal(
        pickGreeting({now: tuesdayMorning, language: "zh-cn", mode: "dev", projectName: "lumina-code", random: rng(0.1, 0.15)}),
        "想在 lumina-code 里构建点什么？",
    );
});

test("fun pool skips {project} entries when no directory is selected", () => {
    // With the {project} entry filtered out, roll 0.1 lands on the next
    // candidate ("What are we building?") instead of a dangling placeholder.
    assert.equal(
        pickGreeting({now: at(8, 22, 10, 0), language: "en-us", mode: "dev", projectName: null, random: rng(0.1, 0.1)}),
        "What are we building?",
    );
});

test("plain greetings cover the four time-of-day tiers", () => {
    const zh = (hour: number) =>
        pickGreeting({now: at(8, 22, hour), language: "zh-cn", mode: "dev", projectName: null, random: rng(0.99)});
    assert.equal(zh(8), "早上好呀，新的一天一起加油");
    assert.equal(zh(14), "下午好呀，今天需要我帮忙做什么呀");
    assert.equal(zh(19), "晚上好呀，今天辛苦啦");
    assert.equal(zh(23), "夜深了，早点休息呀");
    assert.equal(zh(3), "夜深了，早点休息呀");
    assert.equal(
        pickGreeting({now: at(8, 22, 8), language: "en-us", mode: "dev", projectName: null, random: rng(0.99)}),
        "Morning! Let's code.",
    );
});

// --- daily mode (life-assistant pools — no coder memes) ---

test("daily mode never sees the 1024 coder holiday", () => {
    // Oct 24 is also a Saturday afternoon in 2026: with the dev occasion
    // gated out and the weekend gate maxed (0.99), daily lands on the
    // plain afternoon greeting.
    const programmersDay = at(9, 24, 15, 0);
    assert.equal(
        pickGreeting({now: programmersDay, language: "zh-cn", mode: "daily", projectName: null, random: rng(0.99, 0.99)}),
        "下午好呀，需要我搭把手吗",
    );
});

test("daily mode swaps the shared occasions' wording", () => {
    // Thursday meal window keeps the KFC meme, minus the bug.
    assert.equal(
        pickGreeting({now: at(8, 17, 12, 0), language: "zh-cn", mode: "daily", projectName: null, random: rng(0, 0)}),
        "今天疯狂星期四，也要好好吃饭呀",
    );
    // Late night.
    assert.equal(
        pickGreeting({now: at(8, 22, 3, 0), language: "zh-cn", mode: "daily", projectName: null, random: rng(0, 0)}),
        "这个点还没睡呀？再忙也要照顾好自己",
    );
    assert.equal(
        pickGreeting({now: at(8, 22, 3, 0), language: "en-us", mode: "daily", projectName: null, random: rng(0, 0)}),
        "This late? Your ideas will keep till morning.",
    );
    // Friday afternoon.
    assert.equal(
        pickGreeting({now: at(8, 18, 15, 0), language: "zh-cn", mode: "daily", projectName: null, random: rng(0, 0)}),
        "周五啦，这周辛苦了，周末就在眼前~",
    );
    assert.equal(
        pickGreeting({now: at(8, 18, 15, 0), language: "en-us", mode: "daily", projectName: null, random: rng(0, 0)}),
        "Friday. You made it — the weekend is in sight.",
    );
    // Monday morning.
    assert.equal(
        pickGreeting({now: at(8, 21, 8, 0), language: "zh-cn", mode: "daily", projectName: null, random: rng(0, 0)}),
        "周一了，新的一周，慢慢来就好",
    );
    // Weekend daytime.
    assert.equal(
        pickGreeting({now: at(8, 19, 14, 0), language: "zh-cn", mode: "daily", projectName: null, random: rng(0, 0)}),
        "周末好呀，再忙也要记得休息~",
    );
});

test("daily fun pool and plain tiers use life-assistant wording", () => {
    const tuesdayMorning = at(8, 22, 10, 0);
    // Fun gate passes (0.1 < 0.35), index roll 0 → first daily entry.
    assert.equal(
        pickGreeting({now: tuesdayMorning, language: "zh-cn", mode: "daily", projectName: null, random: rng(0.1, 0)}),
        "今天想从哪件事开始？",
    );
    assert.equal(
        pickGreeting({now: tuesdayMorning, language: "en-us", mode: "daily", projectName: null, random: rng(0.1, 0)}),
        "What shall we get done today?",
    );
    // Plain tiers.
    const dailyZh = (hour: number) =>
        pickGreeting({now: at(8, 22, hour), language: "zh-cn", mode: "daily", projectName: null, random: rng(0.99)});
    assert.equal(dailyZh(8), "早上好呀，新的一天开始啦");
    assert.equal(dailyZh(14), "下午好呀，需要我搭把手吗");
    assert.equal(dailyZh(19), "晚上好呀，今天辛苦啦");
    assert.equal(dailyZh(23), "夜深了，早点休息呀");
    assert.equal(dailyZh(3), "夜深了，早点休息呀");
});
