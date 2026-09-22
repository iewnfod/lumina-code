/**
 * Welcome-screen greeting picker (pure). The pools deliberately live here
 * instead of the i18n tables: greetings are content, not UI chrome, and the
 * two languages keep independent pools — a meme that only lands in Chinese
 * (疯狂星期四) must not exist for English users, whereas the i18n fallback
 * would surface its English "key" instead. GreetingLanguage mirrors the
 * i18n Language union structurally so components can pass it through.
 */

export type GreetingLanguage = "en-us" | "zh-cn";

export type GreetingContext = {
    now: Date;
    language: GreetingLanguage;
    /** Compact folder label of the selected working directory, or null. */
    projectName: string | null;
    /** Injectable RNG for tests; defaults to Math.random. */
    random?: () => number;
};

/** Plain time-of-day greetings, indexed by tier: night / morning /
 *  afternoon / evening (the original ChatPlaceholder set, zh texts kept). */
const PLAIN: Record<GreetingLanguage, readonly [string, string, string, string]> = {
    "en-us": ["Good night", "Good morning", "Good afternoon", "Good evening"],
    "zh-cn": ["夜深了，早点休息呀", "早上好呀，新的一天一起加油", "下午好呀，今天需要我帮忙做什么呀", "晚上好呀，今天辛苦啦"],
};

/** Evergreen fun pool, equal weight. Entries containing "{project}" are
 *  skipped when no working directory is selected. */
const FUN: Record<GreetingLanguage, readonly string[]> = {
    "en-us": [
        "Where should we begin?",
        "What should we build in {project}?",
        "What are we building?",
        "What do you want to build today?",
        "Talk is cheap. Show me the code.",
        "Have you tried turning it off and on again?",
        "It works on my machine.",
        "It's not a bug, it's a feature.",
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
};

/** Chance the fun pool is used at all on an unremarkable moment. */
const FUN_CHANCE = 0.35;

type Occasion = {
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

/** Special moments, rarest first — the first one that fires wins. */
const OCCASIONS: readonly Occasion[] = [
    {
        matches: (d) => d.getMonth() === 9 && d.getDate() === 24,
        probability: 1,
        texts: {
            "en-us": ["Happy 1024, fellow programmer."],
            "zh-cn": ["1024 程序员节快乐，愿你写的代码永无 bug"],
        },
    },
    {
        matches: (d) => d.getDay() === 4 && inMealWindow(d),
        probability: 0.3,
        texts: {
            "zh-cn": [
                "今天疯狂星期四，V我50，我告诉你 bug 在哪",
            ],
        },
    },
    {
        matches: (d) => d.getHours() < 5,
        probability: 0.4,
        texts: {
            "en-us": ["Writing code at this hour? Even the bugs are sleepy."],
            "zh-cn": ["这个点了还在写代码？bug 都替你困了..."],
        },
    },
    {
        matches: (d) => d.getDay() === 5 && minutesOfDay(d) >= 13 * 60,
        probability: 0.4,
        texts: {
            "en-us": ["Friday. Maybe don't deploy today."],
            "zh-cn": ["周五不宜部署，宜摸鱼~"],
        },
    },
    {
        matches: (d) => d.getDay() === 1 && d.getHours() >= 5 && d.getHours() < 11,
        probability: 0.3,
        texts: {
            "en-us": ["Monday. Let's get the build green first."],
            "zh-cn": ["周一了，先把编译跑绿，再把人生跑绿"],
        },
    },
    {
        matches: (d) => (d.getDay() === 0 || d.getDay() === 6) && d.getHours() >= 11 && d.getHours() < 18,
        probability: 0.25,
        texts: {
            "en-us": ["Weekend coding: love, or deadline?"],
            "zh-cn": ["周末写代码，是热爱，还是 deadline？"],
        },
    },
];

function plainGreeting(language: GreetingLanguage, hour: number): string {
    const tier = hour >= 5 && hour < 11 ? 1 : hour >= 11 && hour < 18 ? 2 : hour >= 18 && hour < 23 ? 3 : 0;
    return PLAIN[language][tier];
}

function fill(template: string, projectName: string | null): string {
    return template.replace(/\{project\}/g, projectName ?? "");
}

/** Pick the welcome greeting: special occasions (probability-gated) first,
 *  then a plain/fun roll. Pure — date and RNG are injected. */
export function pickGreeting({now, language, projectName, random = Math.random}: GreetingContext): string {
    for (const occasion of OCCASIONS) {
        if (!occasion.matches(now)) continue;
        const texts = occasion.texts[language];
        if (!texts || texts.length === 0) continue;
        if (random() >= occasion.probability) continue;
        return fill(texts[Math.floor(random() * texts.length)], projectName);
    }
    if (random() < FUN_CHANCE) {
        const candidates = FUN[language].filter((t) => projectName !== null || !t.includes("{project}"));
        return fill(candidates[Math.floor(random() * candidates.length)], projectName);
    }
    return plainGreeting(language, now.getHours());
}
