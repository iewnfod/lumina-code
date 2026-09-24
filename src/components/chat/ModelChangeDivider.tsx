import {motion} from "framer-motion";
import {ArrowRight} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import type {OpencodeModel, SessionModelRef} from "../../opencode/types.ts";
import {fadeIn} from "../../lib/motion.ts";

/**
 * The transcript's model-switch divider: a hairline broken by the
 * `previous → current` model names, rendered where the server's persisted
 * `model-switched` marker sits — i.e. the moment the user picked another
 * model, even when the switch pre-dates the next prompt.
 *
 * Names come from the composer's catalog; a model that vanished from it
 * falls back to its raw id. Entrance is gated by TranscriptList's live
 * flag: a divider that appeared while the user watched fades in, history
 * bulk-mounted on open renders statically.
 */
export default function ModelChangeDivider({from, to, models, colors, enter}: {
    from: SessionModelRef;
    to: SessionModelRef;
    /** The model catalog for name resolution (absent in subagent
     *  transcripts — the divider then shows raw model ids). */
    models?: OpencodeModel[];
    colors: SurfaceColors;
    /** True when this divider appeared live at the tail (animate in). */
    enter: boolean;
}) {
    const name = (ref: SessionModelRef) =>
        models?.find((m) => m.providerID === ref.providerID && m.modelID === ref.id)?.name ?? ref.id;
    return (
        <motion.div
            variants={fadeIn}
            initial={enter ? "hidden" : false}
            animate="show"
            className="flex items-center gap-3 py-1 select-none"
        >
            <span className="h-px flex-1" style={{background: colors.glassBorder}}/>
            <span className="inline-flex items-center gap-1.5 min-w-0 text-xs" style={{color: colors.inactiveText}}>
                <span className="truncate max-w-44">{name(from)}</span>
                <ArrowRight size={12} className="shrink-0"/>
                <span className="truncate max-w-44">{name(to)}</span>
            </span>
            <span className="h-px flex-1" style={{background: colors.glassBorder}}/>
        </motion.div>
    );
}
