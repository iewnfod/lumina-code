import type {ReactNode} from "react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";

/** Monospace stack used for mono surfaces (tool output, resource lists). */
const MONO = "var(--font-mono, ui-monospace, monospace)";

/** Mono text style — the family stack plus the settings-driven code-size
 *  token (see hooks/useTypography.ts), so every mono surface (tool
 *  output, resource lists, code blocks) resizes with the Code font size
 *  setting. The former local MONO copies in ToolCard/SubagentCard were
 *  folded into this shared pair. */
export const MONO_STYLE = {fontFamily: MONO, fontSize: "var(--lum-code-size)"} as const;

/** Mono text inline in a sans row (FoldRow's detail slot): MONO_STYLE
 *  plus a baseline optical correction. A flex `items-center` row centers
 *  line boxes, not baselines — the mono span inherits the row's text-sm
 *  line height, and Maple Mono splits its metrics shallower (ascent ~77%
 *  of the content box) than the sans stacks (~80%), so its baseline sits
 *  ~1px above the sans title's (measured in a headless-browser repro
 *  against the installed fonts: 1.00px residual under both Noto Sans and
 *  微软雅黑; prose never shows this because a shared line box aligns
 *  mixed fonts by baseline). `relative` shifts painting without
 *  re-centering the box (items-center redistributes margins) and without
 *  transform's text re-rasterization. */
export const MONO_ROW_STYLE = {
    ...MONO_STYLE,
    position: "relative",
    top: "1px",
} as const;

// CardButton moved to ui/Button.tsx so non-request chrome (the model
// config modal) can share it; re-exported here for the request cards.
export {default as CardButton} from "../ui/Button.tsx";

/** Card chrome shared by the request kinds — mirrors the composer's
 *  surface (recessed bg + glass border) so the pinned stack reads as one
 *  family in its place. The card's hairline is the ONLY border: everything
 *  inside is chrome-less (washes, indents, dimming) so the card reads as
 *  one surface instead of a grid of nested boxes. */
export function Card({colors, children}: {colors: SurfaceColors; children: ReactNode}) {
    return (
        <div
            className="rounded-[var(--radius-lg)] px-4 py-3 flex flex-col gap-3"
            style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
        >
            {children}
        </div>
    );
}
