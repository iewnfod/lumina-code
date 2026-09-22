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
    const {ref: thinkScroll, onScroll: thinkScrollHandler, scrolled: tailScrolled} =
        useFollowBottom<HTMLDivElement>(live);

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
            <div
                ref={thinkScroll}
                onScroll={thinkScrollHandler}
                className={`ml-5 mt-0.5 mb-1 text-sm whitespace-pre-wrap break-words max-h-72 overflow-y-auto opacity-60 leading-relaxed${tailScrolled ? " lum-tail-fade" : ""}`}
            >
                {part.text}
            </div>
        </FoldRow>
    );
}
