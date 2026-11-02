/**
 * Welcome-screen greeting picker (pure). The pools deliberately live here
 * instead of the i18n tables: greetings are content, not UI chrome, and the
 * two languages keep independent pools — a meme that only lands in Chinese
 * (疯狂星期四) must not exist for English users, whereas the i18n fallback
 * would surface its English "key" instead. GreetingLanguage mirrors the
 * i18n Language union structurally so components can pass it through.
 *
 * MODE SPLIT: the pools are additionally split by the app's daily/dev
 * mode (GreetingMode mirrors AppMode structurally the same way — pure
 * module, no import of the React-bearing layer). A daily-mode user must
 * never meet a coder meme (1024, deploy Fridays, bug jokes), so every
 * pool is mode-scoped and occasions with the same trigger but different
 * wording sit as sibling rows told apart only by their `modes` gate.
 */

export type GreetingLanguage = "en-us" | "zh-cn";

/** Structural mirror of AppMode (opencode/appMode.ts) — the
 * GreetingLanguage precedent, keeping this module pure. */
export type GreetingMode = "daily" | "dev";

export type GreetingContext = {
    now: Date;
    language: GreetingLanguage;
    /** Which half of the app is showing — picks the pool family. */
    mode: GreetingMode;
    /** Compact folder label of the selected working directory, or null. */
    projectName: string | null;
    /** Injectable RNG for tests; defaults to Math.random. */
    random?: () => number;
};

/** Plain time-of-day greetings, indexed by tier: night / morning /
 *  afternoon / evening. */
const PLAIN: Record<GreetingMode, Record<GreetingLanguage, readonly [string, string, string, string]>> = {
    daily: {
        "en-us": ["It's late. Rest well.", "Morning! Ready to start the day?", "Good afternoon — what shall we get done?", "Good evening. How was your day?"],
        "zh-cn": ["夜深了，早点休息呀", "早上好呀，新的一天开始啦", "下午好呀，需要我搭把手吗", "晚上好呀，今天辛苦啦"],
    },
    dev: {
        "en-us": ["Late night, sweet dreams.", "Morning! Let's code.", "What can I help you with this afternoon?", "Voila! The evening is ours."],
        "zh-cn": ["夜深了，早点休息呀", "早上好呀，新的一天一起加油", "下午好呀，今天需要我帮忙做什么呀", "晚上好呀，今天辛苦啦"],
    },
};

/** Evergreen fun pool, equal weight. Entries containing "{project}" are
 *  skipped when no working directory is selected — a dev-only concept
 *  (daily sessions live in the fixed workspace), so the daily pool
 *  carries none. */
const FUN: Record<GreetingMode, Record<GreetingLanguage, readonly string[]>> = {
    daily: {
        "en-us": [
            "What shall we get done today?",
            "Got an idea? Let's write it down.",
            "Docs, summaries, plans — name it.",
            "Hand me the small stuff, keep the fun parts.",
            "Big or small, let's get it done.",
            "Where would you like to start?",
        ],
        "zh-cn": [
            "今天想从哪件事开始？",
            "有想法就告诉我，帮你写成文档",
            "写总结、做计划、理思路，都可以交给我",
            "把琐事交给我，你去做更重要的事",
            "万事开头难，我陪你迈出第一步",
            "好记性不如烂笔头，今天记点什么？",
        ],
    },
    dev: {
        "en-us": [
            "Where shall we begin?",
            "What shall we build in {project}?",
            "What are we building?",
            "What do you want to build today?",
            "Talk is cheap. Show me the code.",
            "Have you tried turning it off and on again?",
            "It works on my machine.",
            "It's not a bug! It's a feature!",
            "99 little bugs in the code…",
            "Rome wasn't compiled in a day.",
            "May the fork be with you.",
        ],
        "zh-cn": [
            "我们从哪里开始？",
            "想在 {project} 里构建点什么？",
            "祝今天没有 bug",
            "多喝热水，少写 bug",
            "代码写得好，下班下得早",
            "键盘一响，白写八行",
            "今天也是与编译器斗智斗勇的一天",
        ],
    },
};

/** Chance the fun pool is used at all on an unremarkable moment. */
const FUN_CHANCE = 0.35;

type Occasion = {
    /** Which modes see this occasion; omit for both. */
    modes?: readonly GreetingMode[];
    matches: (now: Date) => boolean;
    /** Chance of firing while the window matches (1 = always). */
    probability: number;
    /** Per-language texts; a missing language skips the occasion entirely. */
    texts: Partial<Record<GreetingLanguage, readonly string[]>>;
};

const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** Meal-window predicate shared by the Thursday and Friday occasions. */
const inMealWindow = (d: Date) => {
    const m = minutesOfDay(d);
    return (m >= 11 * 60 && m <= 13 * 60 + 30) || (m >= 17 * 60 && m <= 19 * 60 + 30);
};

/** Special moments, rarest first — the first one that fires wins. The
 *  daily/dev siblings share a trigger and are told apart by `modes`. */
const OCCASIONS: readonly Occasion[] = [
    {
        // 1024 程序员节 is a coder holiday — daily never sees it.
        modes: ["dev"],
        matches: (d) => d.getMonth() === 9 && d.getDate() === 24,
        probability: 1,
        texts: {
            "en-us": ["Happy 1024. Wish there's no bug in your code."],
            "zh-cn": ["1024 程序员节快乐，愿你写的代码永无 bug"],
        },
    },
    {
        modes: ["dev"],
        matches: (d) => d.getDay() === 4 && inMealWindow(d),
        probability: 0.3,
        texts: {
            "zh-cn": [
                "今天疯狂星期四，V我50，我告诉你 bug 在哪",
            ],
        },
    },
    {
        // Same KFC meme, minus the bug.
        modes: ["daily"],
        matches: (d) => d.getDay() === 4 && inMealWindow(d),
        probability: 0.3,
        texts: {
            "zh-cn": [
                "今天疯狂星期四，也要好好吃饭呀",
            ],
        },
    },
    {
        modes: ["dev"],
        matches: (d) => d.getHours() < 5,
        probability: 0.4,
        texts: {
            "en-us": ["Writing code at this hour? Even the bugs are sleepy."],
            "zh-cn": ["这个点了还在写代码？bug 都替你困了..."],
        },
    },
    {
        modes: ["daily"],
        matches: (d) => d.getHours() < 5,
        probability: 0.4,
        texts: {
            "en-us": ["This late? Your ideas will keep till morning."],
            "zh-cn": ["这个点还没睡呀？再忙也要照顾好自己"],
        },
    },
    {
        modes: ["dev"],
        matches: (d) => d.getDay() === 5 && minutesOfDay(d) >= 13 * 60,
        probability: 0.4,
        texts: {
            "en-us": ["Friday. Deploy less, slack more."],
            "zh-cn": ["周五不宜部署，宜摸鱼~"],
        },
    },
    {
        modes: ["daily"],
        matches: (d) => d.getDay() === 5 && minutesOfDay(d) >= 13 * 60,
        probability: 0.4,
        texts: {
            "en-us": ["Friday. You made it — the weekend is in sight."],
            "zh-cn": ["周五啦，这周辛苦了，周末就在眼前~"],
        },
    },
    {
        modes: ["dev"],
        matches: (d) => d.getDay() === 1 && d.getHours() >= 5 && d.getHours() < 11,
        probability: 0.3,
        texts: {
            "en-us": ["Monday. Get the compilation green first, then get your life green."],
            "zh-cn": ["周一了，先把编译跑绿，再把人生跑绿"],
        },
    },
    {
        modes: ["daily"],
        matches: (d) => d.getDay() === 1 && d.getHours() >= 5 && d.getHours() < 11,
        probability: 0.3,
        texts: {
            "en-us": ["Monday. Fresh week, fresh start."],
            "zh-cn": ["周一了，新的一周，慢慢来就好"],
        },
    },
    {
        modes: ["dev"],
        matches: (d) => (d.getDay() === 0 || d.getDay() === 6) && d.getHours() >= 11 && d.getHours() < 18,
        probability: 0.25,
        texts: {
            "en-us": ["Weekend coding: love, or deadline?"],
            "zh-cn": ["周末写代码，是热爱，还是最后期限到了？"],
        },
    },
    {
        modes: ["daily"],
        matches: (d) => (d.getDay() === 0 || d.getDay() === 6) && d.getHours() >= 11 && d.getHours() < 18,
        probability: 0.25,
        texts: {
            "en-us": ["Weekend! Time to rest — or catch up on life."],
            "zh-cn": ["周末好呀，再忙也要记得休息~"],
        },
    },
];

function plainGreeting(mode: GreetingMode, language: GreetingLanguage, hour: number): string {
    const tier = hour >= 5 && hour < 11 ? 1 : hour >= 11 && hour < 18 ? 2 : hour >= 18 && hour < 23 ? 3 : 0;
    return PLAIN[mode][language][tier];
}

function fill(template: string, projectName: string | null): string {
    return template.replace(/\{project\}/g, projectName ?? "");
}

/** Pick the welcome greeting: special occasions (probability-gated) first,
 *  then a plain/fun roll — all within the given mode's pools. Pure —
 *  date and RNG are injected. */
export function pickGreeting({now, language, mode, projectName, random = Math.random}: GreetingContext): string {
    for (const occasion of OCCASIONS) {
        if (occasion.modes && !occasion.modes.includes(mode)) continue;
        if (!occasion.matches(now)) continue;
        const texts = occasion.texts[language];
        if (!texts || texts.length === 0) continue;
        if (random() >= occasion.probability) continue;
        return fill(texts[Math.floor(random() * texts.length)], projectName);
    }
    if (random() < FUN_CHANCE) {
        const candidates = FUN[mode][language].filter((t) => projectName !== null || !t.includes("{project}"));
        return fill(candidates[Math.floor(random() * candidates.length)], projectName);
    }
    return plainGreeting(mode, language, now.getHours());
}
