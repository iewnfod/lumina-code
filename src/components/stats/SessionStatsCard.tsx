import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import {AnimatePresence, motion} from "framer-motion";
import {Bot, ChevronLeft, ChevronUp, Diff, Square, SquareTerminal} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {durationFast, springSoft, springSnappy} from "../../lib/motion.ts";
import {arrivalDuration} from "../../lib/arrival.ts";
import {useStatsPanelMode} from "../../hooks/useStatsPanelMode.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {OpencodeEventHandler} from "../../opencode/useOpencode.ts";
import type {WorkspaceDiffEntry} from "../../opencode/types.ts";
import type {SessionShellRef, SessionSubagentRef} from "../../opencode/sessionActivity.ts";
import {planStatsLayout} from "./statsLayout.ts";
import IconButton from "../ui/IconButton.tsx";
import Hint from "../ui/Hint.tsx";
import {ChangesSection, DiffCountsBadge, FileDiffBody, FileTitle} from "./ChangesSection.tsx";
import {ShellStateChip, TerminalsSection, TerminalBody, TerminalTitle} from "./TerminalsSection.tsx";
import {SubagentsSection, SubagentBody, SubagentStateChip, SubagentTitle} from "./SubagentsSection.tsx";
import {FadeIn, FinishedTotal, statsRowPresence, statsSectionExit} from "./statsChrome.tsx";

/** Which detail the expanded panel shows; "overview" is the section list. */
type StatsView =
    | {kind: "overview"}
    | {kind: "file"; file: WorkspaceDiffEntry}
    | {kind: "terminal"; shell: SessionShellRef & {running: boolean}}
    | {kind: "subagent"; sub: SessionSubagentRef & {running: boolean}};

/**
 * The session-activity stats card, floating at the top-right of the
 * conversation surface — a SHARED-ELEMENT transition system, not a
 * content swap:
 *
 * - The BOX animates its REAL width/height as a CSS transition (pin →
 *   measure the new content → write the target + a distance-scaled
 *   --lum-size-dur → the engine eases between pixel sizes → release to
 *   auto on transitionend). No
 *   transform ever scales the content, so nothing smears. The content
 *   column is anchored to the box's top-right corner, so it stays put in
 *   viewport space while the box grows around it.
 * - Elements that EXIST in both states (the ±counts, a file's icon+path,
 *   a terminal's command) carry framer `layoutId`s and FLY to their new
 *   position; everything else fades in/out (FadeIn / popLayout exits).
 *   Flying elements never sit inside a fading wrapper — a parent's
 *   opacity would dim the flight.
 * - The container does NOT clip (overflow visible): a clipped flight
 *   would vanish crossing the growing box's edge. Entering content is
 *   hidden by its fade instead, which is what makes the reveal read.
 *
 * Presentation + local navigation state only — the data comes from the
 * WorkspaceStatsCard wrapper (workspace diff by directory + the active
 * session's terminals/subagents; see stats/WorkspaceStatsCard.tsx).
 */
const SessionStatsCard = memo(function SessionStatsCard({
    api,
    subscribe,
    sessionId,
    activity,
    colors,
    directory,
    busyIds,
    onLaneChange,
}: {
    api: OpencodeApi | null;
    subscribe: (handler: OpencodeEventHandler) => () => void;
    /** The active session — terminals/subagents are ITS (see
     *  WorkspaceStatsCard). The card outlives same-directory session
     *  switches, so this prop CHANGES without a remount. */
    sessionId: string;
    activity: {
        diff: WorkspaceDiffEntry[] | null;
        diffLoading: boolean;
        diffTotals: {added: number; removed: number; files: number};
        shells: (SessionShellRef & {running: boolean})[];
        subagents: (SessionSubagentRef & {running: boolean})[];
        refreshDiff: () => void;
        /** Manual stop for one of the session's running shells. */
        stopShell: (shellId: string) => void;
    };
    colors: SurfaceColors;
    directory: string | null;
    busyIds: ReadonlySet<string>;
    /** Reports the right lane a docked panel reserves (0 = none).
     *  `animated` — view-driven changes transition; resize replans snap. */
    onLaneChange: (lane: number, animated: boolean) => void;
}) {
    const t = useI18n();
    const panelMode = useStatsPanelMode();
    // "always" mounts the panel expanded (a directory switch remounts the
    // card — App keys it by directory — restoring the expansion after a
    // manual collapse; same-directory session switches keep whatever the
    // user left).
    const [expanded, setExpanded] = useState(panelMode === "always");
    const [view, setView] = useState<StatsView>({kind: "overview"});
    // Whether the current view's content is final enough to measure.
    // File diffs render synchronously from loaded props; terminal and
    // subagent bodies load async and report through their onSettled
    // prop. Until then the drill HOLDS the pinned pre-drill box size:
    // measuring the loading shell would target a stub (the box shrank
    // to it, then snapped to the real height when the pin released —
    // auto height never transitions), which read as the drill being
    // too fast with a wrong target size. Any other navigation (back,
    // collapse, maximize) settles immediately.
    const [viewSettled, setViewSettled] = useState(true);
    const rootRef = useRef<HTMLDivElement>(null);
    /** The natural-size content wrapper the next box size is measured on. */
    const measureRef = useRef<HTMLDivElement>(null);

    const {diff, diffLoading, diffTotals, shells, subagents, stopShell} = activity;
    const runningShells = shells.filter((s) => s.running).length;
    const runningSubagents = subagents.filter((s) => s.running).length;

    // Nothing to report yet — the card doesn't exist visually (no flash
    // of an empty shell while the first diff loads).
    const visible = diffTotals.files > 0 || shells.length > 0 || subagents.length > 0;
    // Empty sections don't render in the expanded panel either — a
    // section exists only when it has something to show. Changes is
    // exempt while the diff LOADS on a card that's already open for
    // terminals/subagents, so the file list doesn't pop in unannounced.
    const showChanges = diffTotals.files > 0 || (diffLoading && (shells.length > 0 || subagents.length > 0));

    // Data was already cached when this card mounted (a switch to a
    // directory whose workspace diff the module store holds — and whose
    // active-session messages seed the first render): the card enters
    // WITH its content in place (sections skip their staggered fades);
    // activity that first appears later still enters animated.
    const [seeded] = useState(visible);

    // --- Docked-lane planning -------------------------------------------------------
    // An EXPANDED panel (the overview list or a file/terminal/subagent
    // detail) docks when the conversation column can spare the width:
    // ChatView reserves a right lane (padding-right on its root) so the
    // column re-centers beside the panel instead of being covered —
    // detail views also widen toward their cap. Below the crossover the
    // card overlays exactly as before. Geometry and thresholds:
    // statsLayout.ts (pure, tested).
    const [container, setContainer] = useState({w: 0, h: 0});
    const containerRef = useRef({w: 0, h: 0});
    /** Whether the NEXT lane change animates: view-driven transitions
     *  and the card's own (re)appearance do; window-resize replans snap
     *  (animating every resize event reads as rubber-banding). */
    const laneAnimatedRef = useRef(true);
    // `viewSettled` in the hold: an async drill view still counts as
    // the OVERVIEW for geometry — the docked wrapper width, the lane
    // and the height caps keep their pre-drill values in lockstep with
    // the pinned box, and everything widens together when the content
    // settles (same commit: lane effect + measure effect).
    const detail = expanded && view.kind !== "overview" && viewSettled;
    // rem → px at plan time so user zoom (root font-size) scales the
    // thresholds; a typography change mid-dock goes stale until the next
    // resize/view event — acceptable.
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const plan = planStatsLayout(container.w, remPx, expanded, detail);
    const docked = plan.mode === "dock";
    const lane = docked ? plan.laneWidth : 0;

    // Height budgets: `availH` = the container minus the top-4/bottom-4
    // insets, the most the panel may occupy. The panel opens at CONTENT
    // height — detail views cap at availH so a long diff/terminal
    // stretches as tall as it needs; the overview keeps the historical
    // 75vh window cap.
    const availH = container.h > 0 ? Math.max(240, container.h - 32) : 0;
    /** Detail views' content cap (availH); 0 = fall back to the 75vh class. */
    const detailCap = detail && availH > 0 ? availH : 0;

    // Container measurement feeding the plan (width) and the full-height
    // target (height). SEEDED SYNCHRONOUSLY at mount/appearance — a
    // layout effect runs pre-paint, and its state update re-renders
    // before the browser paints, so a card that mounts already expanded
    // reserves its docked lane in the FIRST PAINTED FRAME: the
    // conversation column starts at its correct position and the
    // surface's entrance carries it in (CSS transitions never fire on an
    // element's initial computed style). An appearance within an
    // already-painted conversation surface (activity first arriving
    // mid-session) still glides — there the padding change is a real
    // computed-style change, riding the arrival curve like a manual
    // expand.
    // The observer also fires when OUR OWN lane padding shrinks the
    // content box; offsetWidth/offsetHeight (padding-box) are stable
    // under that, so those fires no-op — without the guard the
    // observer would feed back into the plan.
    useLayoutEffect(() => {
        const parent = rootRef.current?.parentElement;
        if (!parent) return;
        containerRef.current = {w: 0, h: 0};
        // The card's own appearance is view-driven: a lane change it
        // causes post-paint animates.
        laneAnimatedRef.current = true;
        const seedW = parent.offsetWidth;
        const seedH = parent.offsetHeight;
        containerRef.current = {w: seedW, h: seedH};
        setContainer({w: seedW, h: seedH});
        const ro = new ResizeObserver(() => {
            const w = parent.offsetWidth;
            const h = parent.offsetHeight;
            const prev = containerRef.current;
            if (w === prev.w && h === prev.h) return;
            containerRef.current = {w, h};
            // A resize-driven replan snaps: zero the box's size
            // transition so the size change about to commit doesn't
            // animate against a stale --lum-size-dur. animateSizeTo
            // rewrites the var on the next view change.
            laneAnimatedRef.current = false;
            rootRef.current?.style.setProperty("--lum-size-dur", "0ms");
            setContainer({w, h});
        });
        ro.observe(parent);
        return () => ro.disconnect();
    }, [visible]);

    // Report the reserved lane to ChatView. Layout effect so the padding
    // transition starts in the same paint as the card's box animation.
    useLayoutEffect(() => {
        onLaneChange(lane, laneAnimatedRef.current);
    }, [lane, onLaneChange]);

    // The card unmounting while docked (all activity evaporated with the
    // panel open) must release the lane — the column would stay shifted
    // with nothing occupying it.
    const onLaneChangeRef = useRef(onLaneChange);
    onLaneChangeRef.current = onLaneChange;
    useEffect(() => () => onLaneChangeRef.current(0, true), []);

    // --- Box size machinery ---------------------------------------------------------
    // The box's REAL width/height animate as a CSS TRANSITION (the
    // transition-[width,height] utilities below + the --ease-arrival
    // token), with JS doing only what the engine can't: pin the
    // pre-swap size imperatively (pinCurrentSize), measure the incoming
    // content's natural size, write the target values plus the
    // distance-scaled --lum-size-dur, and release the inline properties
    // on transitionend so live content growth (a diff refresh adding
    // rows, terminal output) resizes the card naturally — a timer
    // fallback covers lost end events. Framer itself stays out of this:
    // its animate proved unreliable for the pin (values apply on
    // animation frames, so a pin set in the same tick as a content swap
    // never reached the DOM) and its auto-target handling polluted
    // measurements.
    // WHY THE ENGINE AND NOT A JS LOOP (the rAF integrators that lived
    // here before, spring then bezier): a JS loop competes for
    // main-thread time with the content mounting INSIDE the growing box
    // (framer fades, diff re-renders) — every starved frame was a
    // visible skip, and elapsed-clock catch-up finished the motion in
    // one jump. The engine interpolates during style resolution with
    // zero per-frame JS, and interruptions are native: retargeting a
    // transition starts from its CURRENT interpolated value, which is
    // exactly what the pin froze.
    const sizeAnimRef = useRef<{cleanup: () => void} | null>(null);

    const cancelSizeAnim = useCallback(() => {
        sizeAnimRef.current?.cleanup();
        sizeAnimRef.current = null;
    }, []);

    /** Freeze the container at its CURRENT pixel size — imperative and
     *  synchronous, so the pin holds before React's next commit swaps
     *  the content. FRACTIONAL by design (getBoundingClientRect, not the
     *  integer offsetWidth): rounding the pin up/down fabricates a 1px
     *  delta against the ceil'd measurement target, and a fake width
     *  animation on a width that never changed reads as horizontal
     *  jitter under the right-anchored layout. React never removes these
     *  properties (they're absent from the React style prop); the
     *  transition overwrites them and the arrival release finally
     *  removes them. */
    const pinCurrentSize = useCallback(() => {
        const el = rootRef.current;
        if (!el) return;
        cancelSizeAnim();
        const r = el.getBoundingClientRect();
        el.style.width = `${r.width}px`;
        el.style.height = `${r.height}px`;
    }, [cancelSizeAnim]);

    /** Ease the container's width/height to a target via its CSS
     *  transition; on arrival the inline properties are released so
     *  live content growth (a diff refresh adding rows, terminal
     *  output) resizes the card naturally. Per axis, a target within
     *  2px of the current size is ADOPTED as the current value —
     *  animating a sub-2px delta is invisible at best and jitter at
     *  worst; with both axes adopted there is nothing to animate and
     *  the pin is released immediately. */
    const animateSizeTo = useCallback((to: {w: number; h: number}) => {
        const el = rootRef.current;
        if (!el) return;
        cancelSizeAnim();
        const r = el.getBoundingClientRect();
        const target = {
            w: Math.abs(r.width - to.w) < 2 ? r.width : to.w,
            h: Math.abs(r.height - to.h) < 2 ? r.height : to.h,
        };
        if (Math.abs(target.w - r.width) < 0.01 && Math.abs(target.h - r.height) < 0.01) {
            el.style.removeProperty("width");
            el.style.removeProperty("height");
            return;
        }
        // arrivalDuration speaks SECONDS (lib/motion.ts convention); CSS
        // durations speak milliseconds — convert (an ms/s slip in the old
        // JS loop once jumped progress to 1 on the first frame and
        // swallowed the whole animation).
        const durMs = Math.round(
            arrivalDuration(Math.max(Math.abs(target.w - r.width), Math.abs(target.h - r.height))) * 1000,
        );
        let done = false;
        const onEnd = (e: TransitionEvent) => {
            // Both axes share one duration, so either property's end
            // releases the pair. Children's transitions bubble up to
            // here — match the element and the animated properties.
            if (e.target === el && (e.propertyName === "width" || e.propertyName === "height")) release();
        };
        const release = () => {
            if (done) return;
            done = true;
            el.removeEventListener("transitionend", onEnd);
            window.clearTimeout(timer);
            el.style.removeProperty("width");
            el.style.removeProperty("height");
            sizeAnimRef.current = null;
        };
        el.addEventListener("transitionend", onEnd);
        // Lost end events (a transition canceled before its first frame,
        // an element shuffled out of the render tree) must not leave the
        // box pinned forever: release on a timer too, just past the
        // transition's own end.
        const timer = window.setTimeout(release, durMs + 120);
        // An interruption (a new pin mid-flight) detaches the listeners
        // and leaves the inline sizes exactly where they are — the next
        // animateSizeTo retargets the transition from the current
        // interpolated value.
        sizeAnimRef.current = {
            cleanup: () => {
                el.removeEventListener("transitionend", onEnd);
                window.clearTimeout(timer);
            },
        };
        el.style.setProperty("--lum-size-dur", `${durMs}ms`);
        el.style.width = `${target.w}px`;
        el.style.height = `${target.h}px`;
    }, [cancelSizeAnim]);

    useEffect(() => cancelSizeAnim, [cancelSizeAnim]);

    // What mounted the current panel content. A card EXPAND wants new
    // content to wait while the box grows; an in-panel navigation (drill/
    // back) must swap near-instantly — the old view is gone in 150ms, and
    // a delayed successor reads as a blank flash. The expand delay sits
    // PAST the box's landing (~160-260ms by distance): a burst of framer
    // fade tweens starting mid-flight was congesting the tail — the
    // slowest part of the curve, where the eye catches every dropped
    // frame.
    const navKindRef = useRef<"expand" | "nav">(seeded ? "nav" : "expand");
    /** Row flight layoutIds are ARMED on pointer-down: rows mount bare
     *  (mount-time pairing against framer's stale registry boxes is what
     *  produced phantom/wrong-origin flights), and arming a beat before
     *  the drill click unmounts them means their boxes are still stored
     *  for the header titles to fly from. */
    const [flightsArmed, setFlightsArmed] = useState(false);
    const contentFadeDelay = navKindRef.current === "expand" ? 0.22 : 0;

    // The expand-time diff re-fetch is deferred past the box's landing
    // (arrivalDuration caps at 260ms): its response re-renders the whole
    // panel, and that commit landing inside the animation window was the
    // tail's biggest stutter source. 320ms is imperceptible for data
    // freshness — the panel opens on the data it already has.
    const refreshTimerRef = useRef<number | null>(null);
    useEffect(() => {
        const timer = refreshTimerRef;
        return () => {
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, []);

    const expand = useCallback(() => {
        laneAnimatedRef.current = true;
        navKindRef.current = "expand";
        setViewSettled(true);
        pinCurrentSize();
        setExpanded(true);
        setNavTick((n) => n + 1);
        setFlightsArmed(false);
        if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = window.setTimeout(() => {
            refreshTimerRef.current = null;
            activity.refreshDiff();
        }, 320);
    }, [pinCurrentSize, activity]);

    const collapse = useCallback(() => {
        laneAnimatedRef.current = true;
        setViewSettled(true);
        pinCurrentSize();
        setExpanded(false);
        setView({kind: "overview"});
        setNavTick((n) => n + 1);
        setFlightsArmed(false);
    }, [pinCurrentSize]);

    const drill = useCallback((next: StatsView) => {
        laneAnimatedRef.current = true;
        navKindRef.current = "nav";
        pinCurrentSize();
        setView(next);
        // File diffs render synchronously from already-loaded props;
        // terminal/subagent bodies load async and report through
        // onSettled — until then the box holds its pre-drill size.
        setViewSettled(next.kind === "file");
        setNavTick((n) => n + 1);
        setFlightsArmed(false);
    }, [pinCurrentSize]);

    const back = useCallback(() => {
        laneAnimatedRef.current = true;
        navKindRef.current = "nav";
        setViewSettled(true);
        pinCurrentSize();
        setView({kind: "overview"});
        setNavTick((n) => n + 1);
        setFlightsArmed(false);
    }, [pinCurrentSize]);

    // A same-directory session switch keeps this card mounted — but any
    // open drill view points at the PREVIOUS session's row (liveShell/
    // liveSub fall back to the stale view.shell/view.sub), which is
    // exactly the inherited-content class of bug. The session change
    // resets to the overview with the same pinned+measured morph as
    // back(), so the box glides instead of snapping. (Refs, not deps:
    // view/pin are read at fire time — the effect keys on the session
    // change alone, like the panelMode effect below.)
    const viewRef = useRef(view);
    viewRef.current = view;
    const sessionIdRef = useRef(sessionId);
    useEffect(() => {
        if (sessionIdRef.current === sessionId) return;
        sessionIdRef.current = sessionId;
        setFlightsArmed(false);
        if (viewRef.current.kind === "overview") return;
        laneAnimatedRef.current = true;
        navKindRef.current = "nav";
        setViewSettled(true);
        pinCurrentSize();
        setView({kind: "overview"});
        setNavTick((n) => n + 1);
    }, [sessionId, pinCurrentSize]);

    /** Async drill bodies (terminal output, subagent transcript) report
     *  their first real content here — the held pin releases into ONE
     *  paced morph toward the now-measurable size. Idempotent; fires at
     *  most once per drill (the bodies gate it on a boolean flip). */
    const handleViewSettled = useCallback(() => setViewSettled(true), []);

    // Outside pointer-down / Escape collapse the panel (PopoverMenu's
    // capture-phase pattern) — only in "auto" mode. "always" keeps the
    // panel open through outside interaction; its own collapse button
    // still works and lasts until the card remounts.
    useEffect(() => {
        if (!expanded || panelMode !== "auto") return;
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) collapse();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") collapse();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [expanded, panelMode, collapse]);

    // Switching the mode to "always" mid-session expands a collapsed
    // card right away (the full expand animation); switching back to
    // "auto" leaves it as-is — the next outside click collapses it.
    // Refs, not deps: `expand` and `expanded` change without the mode
    // changing, and re-running on those would fight manual collapse.
    const expandedRef = useRef(expanded);
    expandedRef.current = expanded;
    const expandRef = useRef(expand);
    expandRef.current = expand;
    useEffect(() => {
        if (panelMode === "always" && !expandedRef.current) expandRef.current();
    }, [panelMode]);

    // After every navigation (each handler pins the box first), measure
    // the incoming content's natural size and spring the box to it. The
    // measure wrapper MUST NOT shrink (shrink-0 below): a flex child
    // under the pinned container compresses, and measuring a compressed
    // element is what used to corrupt every target size. The first run
    // (mount) is skipped — the card enters at its natural size. An
    // unsettled async drill view SKIPS the measurement (the held pin
    // keeps the box at its pre-drill size) until onSettled re-runs this
    // with real content.
    const [navTick, setNavTick] = useState(0);
    const mountedRef = useRef(false);
    useLayoutEffect(() => {
        if (!mountedRef.current) {
            mountedRef.current = true;
            return;
        }
        if (!viewSettled) return;
        const m = measureRef.current;
        if (!m) return;
        const r = m.getBoundingClientRect();
        // Height cap for the measured content: detail views cap at the
        // container's full height; the overview keeps the 75vh window cap.
        const maxH = detailCap > 0 ? detailCap : Math.max(240, window.innerHeight * 0.75);
        animateSizeTo({w: Math.ceil(r.width), h: Math.ceil(Math.min(r.height, maxH))});
    }, [expanded, view.kind, navTick, viewSettled, animateSizeTo]);

    // Drill views resolve their entry LIVE (by id/path) so state updates
    // flow in — a terminal that exits while open must stop pulsing and
    // polling, a refreshed diff must re-render the open file view.
    const liveFile =
        view.kind === "file"
            ? diff?.find((e) => e.file === view.file.file) ?? view.file
            : null;
    const liveShell =
        view.kind === "terminal"
            ? shells.find((s) => s.id === view.shell.id) ?? view.shell
            : null;
    const liveSub =
        view.kind === "subagent"
            ? subagents.find((s) => s.id === view.sub.id) ?? view.sub
            : null;

    // The shadow animates BETWEEN states instead of living in the static
    // style: the collapsed pill only needs a whisper (a panel-scale
    // elevation shadow reads as a halo on something this small), while
    // the expanded panel wants real elevation. Both values are
    // single-layer shadows with identical structure, so the CSS engine
    // interpolates them natively — the transition on the root (same
    // curve, same --lum-size-dur as the box) carries it, keeping framer
    // JS out of the animation's per-frame path entirely.
    const surfaceStyle = {
        background: "var(--color-elevated)",
        border: `1px solid ${colors.glassBorder}`,
        color: colors.dark ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.88)",
        boxShadow: "var(--lum-stats-shadow)",
        "--lum-stats-shadow": expanded ? colors.elevationShadow : "0 1px 3px rgba(0,0,0,0.06)",
    } as React.CSSProperties;

    /** "已完成 / 总数" — finished prominent, total dimmed behind the
     *  slash; each number rolls on change (see RollingValue). */
    const StatCount = ({finished, total, label}: {finished: number; total: number; label: string}) => (
        <Hint label={`${label} · ${finished} / ${total}`}>
            <FinishedTotal finished={finished} total={total}/>
        </Hint>
    );

    return (
        <AnimatePresence>
            {visible && (
                <motion.div
                    ref={rootRef}
                    // The card lives OUTSIDE the session swap (App mounts
                    // it beside the transcript, keyed by directory): it
                    // only ever mounts as a real arrival — the directory
                    // layer appearing on a cross-project switch, or
                    // activity first appearing — so it always enters
                    // animated. First app paint is exempt via the outer
                    // AnimatePresence's initial={false}.
                    initial={{opacity: 0, y: 8}}
                    animate={{opacity: 1, y: 0}}
                    exit={{opacity: 0, y: 8, transition: {duration: durationFast}}}
                    transition={springSoft}
                    // Content anchored top-right: it holds still in
                    // viewport space while the box grows around it (no
                    // clip — flights cross the growing edge in the open).
                    // The width/height/box-shadow transition is the
                    // box-size machinery's engine: --ease-arrival sets
                    // the curve, --lum-size-dur (written per animation by
                    // animateSizeTo) the distance-scaled duration. The
                    // shadow rides along (single-layer values interpolate
                    // natively) so framer JS stays out of the per-frame
                    // path entirely.
                    className="absolute right-4 top-4 z-30 rounded-[var(--radius-lg)] select-none flex justify-end items-start transition-[width,height,box-shadow] duration-[var(--lum-size-dur,200ms)] ease-[var(--ease-arrival)]"
                    style={surfaceStyle}
                >
                    {/* shrink-0 is load-bearing: a flex child under the
                        pinned container compresses, and every size
                        measurement would read the squeezed box. */}
                    <div
                        ref={measureRef}
                        className={`shrink-0 ${expanded && !docked ? "w-[min(26rem,calc(100vw-24rem))]" : "w-max"}`}
                        style={docked ? {width: plan.panelWidth} : undefined}
                    >
                        <AnimatePresence mode="popLayout" initial={false}>
                            {!expanded ? (
                                <motion.button
                                    key="collapsed"
                                    type="button"
                                    initial={seeded ? {opacity: 1} : {opacity: 0}}
                                    animate={{opacity: 1, transition: springSnappy}}
                                    exit={{opacity: 0, transition: {duration: durationFast}}}
                                    onClick={expand}
                                    className="flex flex-col items-stretch gap-1 px-3 py-2.5 cursor-pointer rounded-[var(--radius-lg)] text-xs transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-stats-hover)]"
                                    style={{"--lum-stats-hover": colors.hoverOverlay} as React.CSSProperties}
                                    aria-label={t["Workspace activity"]}
                                >
                                    {/* The pill's rows are presence-animated
                                        (popLayout): terminals/subagents are
                                        session-scoped inside the directory-
                                        keyed card, so a same-directory switch
                                        swaps them in place — old rows pop out
                                        of the stack and fade, new ones fade
                                        in; the changes row rides the same
                                        pair when the workspace goes clean ↔
                                        dirty. popLayout (safe here — the pill
                                        never scrolls) keeps the stack from
                                        doubling while the old rows fade. */}
                                    <AnimatePresence initial={false} mode="popLayout">
                                        {diffTotals.files > 0 && (
                                            <motion.span key="changes" {...statsRowPresence()} className="flex items-center justify-between gap-2">
                                                <Diff size={13} className="shrink-0 opacity-70"/>
                                                <DiffCountsBadge added={diffTotals.added} removed={diffTotals.removed}/>
                                            </motion.span>
                                        )}
                                        {shells.length > 0 && (
                                            <motion.span key="terminals" {...statsRowPresence()} className="flex items-center justify-between gap-2">
                                                <SquareTerminal
                                                    size={13}
                                                    className={`shrink-0 opacity-70${runningShells > 0 ? " animate-pulse" : ""}`}
                                                />
                                                <StatCount
                                                    finished={shells.length - runningShells}
                                                    total={shells.length}
                                                    label={t["Terminals"]}
                                                />
                                            </motion.span>
                                        )}
                                        {subagents.length > 0 && (
                                            <motion.span key="subagents" {...statsRowPresence()} className="flex items-center justify-between gap-2">
                                                <Bot
                                                    size={13}
                                                    className={`shrink-0 opacity-70${runningSubagents > 0 ? " animate-pulse" : ""}`}
                                                />
                                                <StatCount
                                                    finished={subagents.length - runningSubagents}
                                                    total={subagents.length}
                                                    label={t["Subagents"]}
                                                />
                                            </motion.span>
                                        )}
                                    </AnimatePresence>
                                </motion.button>
                            ) : (
                                <motion.div
                                    key="expanded"
                                    // No ENTER fade: a root opacity would dim
                                    // the flights inside. Entering content
                                    // fades itself (FadeIn); the panel's exit
                                    // still fades as a whole.
                                    exit={{opacity: 0, transition: {duration: durationFast}}}
                                    // Height mode: a detail view caps its
                                    // content at the container's height
                                    // (grows with content, no empty floor);
                                    // the overview keeps the 75vh class cap.
                                    className={`${detailCap > 0 ? "" : "max-h-[75vh]"} flex flex-col`}
                                    style={detailCap > 0 ? {maxHeight: detailCap} : undefined}
                                >
                                    {/* Panel header: back (in a drill view), the
                                        title — the flying shared element in
                                        drill views — and the collapse button. */}
                                    <div className="flex items-center gap-1 pl-1.5 pr-2 py-1.5 shrink-0 min-w-0">
                                        {view.kind !== "overview" && (
                                            <FadeIn delay={0.03} className="shrink-0">
                                                <IconButton
                                                    size={24}
                                                    hoverOverlay={colors.hoverOverlay}
                                                    activeOverlay={colors.activeOverlay}
                                                    onClick={back}
                                                    aria-label={t["Back"]}
                                                >
                                                    <ChevronLeft size={14}/>
                                                </IconButton>
                                            </FadeIn>
                                        )}
                                        {view.kind === "file" && liveFile ? (
                                            <FileTitle entry={liveFile} directory={directory} className="flex-1"/>
                                        ) : view.kind === "terminal" && liveShell ? (
                                            <TerminalTitle shell={liveShell} className="flex-1"/>
                                        ) : view.kind === "subagent" && liveSub ? (
                                            <SubagentTitle sub={liveSub} className="flex-1"/>
                                        ) : (
                                            // Aligns the title's text with the section
                                            // content below (body px-3 + section px-2 =
                                            // 20px; header pl-1.5 + this pl-3.5 = 20px).
                                            <FadeIn delay={contentFadeDelay} className="flex-1 min-w-0 pl-3.5 text-xs font-medium truncate">
                                                {t["Workspace activity"]}
                                            </FadeIn>
                                        )}
                                        {view.kind === "file" && liveFile && (
                                            <FadeIn delay={0.03} className="shrink-0">
                                                <DiffCountsBadge added={liveFile.additions} removed={liveFile.deletions}/>
                                            </FadeIn>
                                        )}
                                        {view.kind === "terminal" && liveShell && (
                                            <FadeIn delay={0.03} className="shrink-0">
                                                <ShellStateChip shell={liveShell} colors={colors}/>
                                            </FadeIn>
                                        )}
                                        {view.kind === "terminal" && liveShell?.running && (
                                            <FadeIn delay={0.03} className="shrink-0">
                                                <IconButton
                                                    size={24}
                                                    hoverOverlay={colors.hoverOverlay}
                                                    activeOverlay={colors.activeOverlay}
                                                    onClick={() => stopShell(liveShell.id)}
                                                    aria-label={t["Stop"]}
                                                >
                                                    <Square size={12} className="fill-current" style={{color: "#ef4444"}}/>
                                                </IconButton>
                                            </FadeIn>
                                        )}
                                        {view.kind === "subagent" && liveSub && (
                                            <FadeIn delay={0.03} className="shrink-0">
                                                <SubagentStateChip running={liveSub.running} colors={colors}/>
                                            </FadeIn>
                                        )}
                                        <FadeIn delay={contentFadeDelay} className="shrink-0">
                                            <IconButton
                                                size={24}
                                                hoverOverlay={colors.hoverOverlay}
                                                activeOverlay={colors.activeOverlay}
                                                onClick={collapse}
                                                aria-label={t["Collapse"]}
                                            >
                                                <ChevronUp size={14}/>
                                            </IconButton>
                                        </FadeIn>
                                    </div>
                                    {/* Views swap DIRECTLY (no AnimatePresence):
                                        entering content fades in fast and the
                                        flying titles carry the continuity — an
                                        exiting view popped absolute inside a
                                        scroll container mis-measured the
                                        back-navigation flights (they started
                                        from the panel's top-left corner). */}
                                    <div
                                        // flex-1: the content area fills the
                                        // panel's height when a detail view
                                        // caps it, instead of stranding
                                        // content in the top half; no-op at
                                        // content height.
                                        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-3"
                                        onPointerDown={() => setFlightsArmed(true)}
                                    >
                                        {view.kind === "overview" && (
                                            <>
                                                {/* Sections are presence-wrapped
                                                    (exit-only — entrance keeps
                                                    each section's own FadeIn
                                                    choreography, a wrapper
                                                    enter fade would compound
                                                    opacities): a section
                                                    emptying out, or leaving
                                                    with a same-directory
                                                    session switch, fades
                                                    instead of snapping. The
                                                    terminal/subagent ROWS
                                                    swap animated inside their
                                                    sections (statsRowPresence). */}
                                                <AnimatePresence initial={false}>
                                                    {showChanges && (
                                                        <motion.div key="changes" {...statsSectionExit}>
                                                            <ChangesSection
                                                                diff={diff}
                                                                loading={diffLoading}
                                                                totals={diffTotals}
                                                                colors={colors}
                                                                directory={directory}
                                                                fadeDelay={contentFadeDelay}
                                                                flight={flightsArmed}
                                                                onOpenFile={(file) => drill({kind: "file", file})}
                                                            />
                                                        </motion.div>
                                                    )}
                                                    {shells.length > 0 && (
                                                        <motion.div key="terminals" {...statsSectionExit}>
                                                            <TerminalsSection
                                                                shells={shells}
                                                                colors={colors}
                                                                fadeDelay={contentFadeDelay}
                                                                flight={flightsArmed}
                                                                onOpenTerminal={(shell) => drill({kind: "terminal", shell})}
                                                                onStopShell={stopShell}
                                                            />
                                                        </motion.div>
                                                    )}
                                                    {subagents.length > 0 && (
                                                        <motion.div key="subagents" {...statsSectionExit}>
                                                            <SubagentsSection
                                                                subagents={subagents}
                                                                colors={colors}
                                                                fadeDelay={contentFadeDelay}
                                                                flight={flightsArmed}
                                                                onOpenSubagent={(sub) => drill({kind: "subagent", sub})}
                                                            />
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </>
                                        )}
                                        {view.kind === "file" && liveFile && (
                                            <FileDiffBody entry={liveFile} colors={colors}/>
                                        )}
                                        {view.kind === "terminal" && liveShell && (
                                            <TerminalBody
                                                api={api}
                                                shell={liveShell}
                                                colors={colors}
                                                directory={directory}
                                                onSettled={handleViewSettled}
                                            />
                                        )}
                                        {view.kind === "subagent" && liveSub && (
                                            <SubagentBody
                                                api={api}
                                                subscribe={subscribe}
                                                sub={liveSub}
                                                colors={colors}
                                                directory={directory}
                                                busyIds={busyIds}
                                                onSettled={handleViewSettled}
                                            />
                                        )}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
});

export default SessionStatsCard;
