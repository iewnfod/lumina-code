import {Brain} from "lucide-react";
import type {AssistantReasoningPart} from "../../opencode/types.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {useFollowBottom} from "../../hooks/useFollowBottom.ts";
import {AUTO_EXPAND_MIN_DWELL_MS, useExpansion} from "./useExpansion.ts";
import FoldRow from "./FoldRow.tsx";

/**
 * Reasoning-model thinking process: a dimmed disclosure above the answer.
 * Expanded (live) while the thoughts stream in, auto-collapsed once the
 * model moves on to the answer — unless the reader toggled it themselves.
 */
export default function ThinkingBlock({part, stateKey, live}: {part: AssistantReasoningPart; stateKey: string; live: boolean}) {
    const t = useI18n();
    const {expanded, toggle} = useExpansion(stateKey, live, AUTO_EXPAND_MIN_DWELL_MS);
    const {ref: thinkScroll, onScroll: thinkScrollHandler, top: tailTop, bottom: tailBottom} =
        useFollowBottom<HTMLDivElement>(live);
    // The streamed-tail guard is only needed once the text actually
    // overflows (before that nothing is pinned or cut), so the pb rides
    // the overflow flags — a short thinking block keeps its box tight.
    const tailGuard = tailTop || tailBottom;

    // Collapsed rows carry the thought's first line as a preview.
    const snippet = part.text.trim().split("\n")[0] ?? "";

    return (
        <FoldRow
            icon={<Brain size={14} className={live ? "animate-pulse" : ""} />}
            title={live ? t["Thinking..."] : t["Thought process"]}
            detail={!expanded && snippet ? (
                <span className="truncate">{snippet}</span>
            ) : null}
            expanded={expanded}
            onToggle={toggle}
        >
            {/* Naked scroller (no painted chrome of its own) — the mask
             * rides it directly; lg tier (the thinking stream is a big
             * reading block), fades only while a side has hidden content
             * (useFollowBottom's edge flags). While the stream overflows,
             * pb-6 keeps the follow pin's one-paint scrollTop lag over
             * padding instead of the newest line (scrolled up, the bottom
             * fade covers real hidden content as usual). */}
            <div
                ref={thinkScroll}
                onScroll={thinkScrollHandler}
                className={`ml-5 mt-0.5 mb-1 text-sm whitespace-pre-wrap break-words max-h-64 overflow-y-auto${tailGuard ? " pb-6" : ""} opacity-60 leading-relaxed lum-fade-lg${tailTop ? " lum-fade-top" : ""}${tailBottom ? " lum-fade-bottom" : ""}`}
            >
                {part.text}
            </div>
        </FoldRow>
    );
}
