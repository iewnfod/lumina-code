/**
 * Pure layout planning for the session-stats card's DOCKED mode.
 *
 * Any EXPANDED panel (the overview list or a file/terminal/subagent
 * detail) wants the conversation column out from under it. When the
 * column can spare the width, the card DOCKS: it reserves a right lane
 * (padding-right on ChatView's root) so the centered, width-capped
 * column (chatColumn.ts) re-centers in the remaining space instead of
 * being covered — the overview docks at its compact width, while detail
 * views also WIDEN toward their 40rem cap. Below the crossover the card
 * keeps the overlay behavior (float over the column, exactly today's
 * layout).
 *
 * The panel is ELASTIC: it shrinks toward its minimum before giving up,
 * so the dock/overlay boundary is continuous rather than a jump — and
 * the column is width-capped (chatColumn.ts), never pushed wider by a
 * dock: with spare width it only re-centers (zero reflow); tighter
 * windows narrow it toward the readable floor. A wide-tier (64rem)
 * column gives up more before reaching that floor — the tier itself
 * stays put because ChatView measures border-box, stable under this
 * lane's padding.
 *
 * All rem constants scale with the root font size (user zoom), so the
 * caller passes the current px-per-rem.
 */

export interface StatsLanePlan {
    mode: "dock" | "overlay";
    /** Docked panel width in px (0 in overlay). */
    panelWidth: number;
    /** Reserved right lane in px (0 in overlay) — applied as
     *  padding-right on ChatView's root. */
    laneWidth: number;
}

/** Preferred detail-panel width (the cap; the panel shrinks below it). */
const PANEL_WIDE_REM = 40;
/** Minimum dock width — the overview's compact width and the detail
 *  panel's shrink floor; below it the card overlays instead of docking. */
const PANEL_MIN_REM = 26;
/** The conversation column never narrows past this while docked. */
const COLUMN_FLOOR_REM = 36;
/** The column's own side gutters while capped (both sides — chatColumn's
 *  compact tier). Docking never coexists with the roomy uncapped
 *  gutters: those live below the base cap, where the budget is already
 *  overlay territory — and a lane that narrows the column below its cap
 *  still reads as capped (border-box measurement). */
const COLUMN_PAD_REM = 3;
/** The card's right-4 offset (fixed px, not rem-scaled). */
const CARD_RIGHT_PX = 16;
/** Breathing room between the column's edge and the docked panel. */
const LANE_GAP_PX = 12;

const OVERLAY: StatsLanePlan = {mode: "overlay", panelWidth: 0, laneWidth: 0};

/**
 * Decide dock vs overlay for the current container width.
 *
 * @param containerWidth ChatView root width in px (border-box — stable
 *        under the lane's own padding-right).
 * @param remPx Current px-per-rem (root font size), for zoom scaling.
 * @param expanded Whether the panel is open (overview or detail) — a
 *        collapsed card never docks.
 * @param detail Whether the open view is a detail (file/terminal/
 *        subagent) — details widen toward their cap; the overview docks
 *        at its compact width.
 */
export function planStatsLayout(containerWidth: number, remPx: number, expanded: boolean, detail: boolean): StatsLanePlan {
    if (!expanded || remPx <= 0) return OVERLAY;
    // Width the conversation can spare: everything left after the column
    // keeps its floor + gutters, minus the card's right offset and gap.
    const budget =
        containerWidth - (COLUMN_FLOOR_REM + COLUMN_PAD_REM) * remPx - CARD_RIGHT_PX - LANE_GAP_PX;
    if (budget < PANEL_MIN_REM * remPx) return OVERLAY;
    // Elastic: take the full preferred width only when affordable.
    const preferred = (detail ? PANEL_WIDE_REM : PANEL_MIN_REM) * remPx;
    const panelWidth = Math.floor(Math.min(budget, preferred));
    return {mode: "dock", panelWidth, laneWidth: panelWidth + CARD_RIGHT_PX + LANE_GAP_PX};
}
