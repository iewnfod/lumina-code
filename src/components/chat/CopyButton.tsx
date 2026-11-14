import {Check, Copy} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import Hint from "../ui/Hint.tsx";

/**
 * The transcript's copy affordance — the ONE hint-wrapped icon button
 * behind run footers, user bubbles and code blocks (hover/reveal styling
 * arrives via `className`; the copied check swap and i18n hint are the
 * shared half). The `useCopy` hook stays at the call site (its reset
 * timer owns the caller's copied flag).
 */
export default function CopyButton({copied, onCopy, className, hintClassName}: {
    copied: boolean;
    onCopy: () => void;
    /** The button's full class list — size/rounding/wash/reveal policy
     *  differ per host (always-on vs hover-revealed vs .lum-md-copy). */
    className: string;
    /** Sizing/offset classes for the Hint trigger wrapper. */
    hintClassName?: string;
}) {
    const t = useI18n();
    return (
        <Hint label={copied ? t["Copied"] : t["Copy"]} className={hintClassName}>
            <button
                type="button"
                onClick={onCopy}
                className={className}
            >
                {copied
                    ? <Check size={14} className="shrink-0"/>
                    : <Copy size={14} className="shrink-0"/>}
            </button>
        </Hint>
    );
}
