/**
 * Pure position planning for the stats panel.
 *
 * The panel is a REAL FLEX SIBLING of the conversation (App renders the
 * row: conversation flex-1 + panel). ONE rule with three gates decides
 * only the panel's position — everything else (how wide the conversation
 * ends up, re-centering while the panel grows or shrinks) is plain flex
 * reflow and needs no bookkeeping:
 *
 * 1. A card that shows NOTHING (no diff, no terminals, no subagents) or
 *    is COLLAPSED floats — position: absolute, out of flow. Hard
 *    binding, no exceptions: no card on screen ⇒ the conversation
 *    column keeps the full width.
 * 2. An EXPANDED panel reads the conversation surface's WIDTH — and
 *    only that: wide enough to fit the WIDEST panel beside the
 *    conversation column's readable floor → IN FLOW (position: static,
 *    fixed width — overview 26rem, detail 40rem): the panel and the
 *    conversation collide and flex pushes the conversation left.
 *    The threshold is a window-size property, so drilling between
 *    overview and detail never flips the mode.
 * 3. Anything narrower → FLOAT (absolute, covering the column's right
 *    margin). No pushing.
 *
 * The panel's own width/height keep transitioning (SessionStatsCard's
 * box machinery), and because it sits in flow the conversation rides
 * every frame of that transition for free.
 *
 * All rem constants scale with the root font size (user zoom), so the
 * caller passes the current px-per-rem.
 */

export interface StatsPanelPlan {
    mode: "flow" | "float";
    /** In-flow panel width in px (0 when floating). */
    panelWidth: number;
}

/** In-flow panel widths by view: the overview list is compact; detail
 *  views (file diffs, terminal output, subagent transcripts) read wide. */
export const OVERVIEW_PANEL_REM = 26;
export const DETAIL_PANEL_REM = 40;
/** The conversation column never narrows past this beside the panel. */
const COLUMN_FLOOR_REM = 36;
/** The column's own side gutters while capped (chatColumn's compact
 *  tier — flow mode only happens at widths far above the roomy tier). */
const COLUMN_PAD_REM = 3;
/** The panel's right margin in flow (fixed px, not rem-scaled) — the
 *  same 16px inset it keeps while floating (right-4). */
const PANEL_MARGIN_PX = 16;

const FLOAT: StatsPanelPlan = {mode: "float", panelWidth: 0};

/**
 * Decide flow vs float for the conversation surface.
 *
 * @param surfaceWidth The conversation surface's width in px (App
 *        measures the flex row beside the sidebar — NOT the window).
 * @param remPx Current px-per-rem (root font size), for zoom scaling.
 * @param visible Whether the card shows anything at all — an invisible
 *        card is out of flow.
 * @param expanded Whether the panel is open — a collapsed pill floats.
 * @param detail Whether the open view is a detail (file/terminal/
 *        subagent) — picks the panel's fixed width; never the mode.
 */
export function planStatsPanel(surfaceWidth: number, remPx: number, visible: boolean, expanded: boolean, detail: boolean): StatsPanelPlan {
    if (!visible || !expanded || remPx <= 0) return FLOAT;
    // Enter flow only where the WIDEST panel fits beside the column's
    // floor and gutters. At 16px/rem this lands on exactly 1280px — the
    // column's own wide tier (chatColumn.ts); a coincidence, kept
    // independent on purpose.
    const flowAt = (COLUMN_FLOOR_REM + COLUMN_PAD_REM + DETAIL_PANEL_REM) * remPx + PANEL_MARGIN_PX;
    if (surfaceWidth < flowAt) return FLOAT;
    const panelWidth = Math.round((detail ? DETAIL_PANEL_REM : OVERVIEW_PANEL_REM) * remPx);
    return {mode: "flow", panelWidth};
}
