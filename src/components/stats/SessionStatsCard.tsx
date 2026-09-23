import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import {AnimatePresence, motion} from "framer-motion";
import {Bot, ChevronLeft, ChevronUp, Diff, SquareTerminal} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {durationFast, springSoft, springSnappy} from "../../lib/motion.ts";
import {arrivalDuration} from "../../lib/arrival.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {OpencodeEventHandler} from "../../opencode/useOpencode.ts";
import type {SessionDiffEntry} from "../../opencode/types.ts";
import type {SessionShellRef, SessionSubagentRef} from "../../opencode/sessionActivity.ts";
import IconButton from "../ui/IconButton.tsx";
import Hint from "../ui/Hint.tsx";
import {ChangesSection, DiffCountsBadge, FileDiffBody, FileTitle} from "./ChangesSection.tsx";
import {ShellStateChip, TerminalsSection, TerminalBody, TerminalTitle} from "./TerminalsSection.tsx";
import {SubagentsSection, SubagentBody, SubagentStateChip, SubagentTitle} from "./SubagentsSection.tsx";
import {FadeIn, FinishedTotal} from "./statsChrome.tsx";

/** Which detail the expanded panel shows; "overview" is the section list. */
type StatsView =
    | {kind: "overview"}
    | {kind: "file"; file: SessionDiffEntry}
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
 * The data comes from useSessionActivity (owned by ChatView); this
 * component is presentation + local navigation state only.
 */
const SessionStatsCard = memo(function SessionStatsCard({
    api,
    subscribe,
    activity,
    colors,
    directory,
    busyIds,
}: {
    api: OpencodeApi | null;
    subscribe: (handler: OpencodeEventHandler) => () => void;
    activity: {
        diff: SessionDiffEntry[] | null;
        diffLoading: boolean;
        diffTotals: {added: number; removed: number; files: number};
        shells: (SessionShellRef & {running: boolean})[];
        subagents: (SessionSubagentRef & {running: boolean})[];
        refreshDiff: () => void;
    };
    colors: SurfaceColors;
    directory: string | null;
    busyIds: ReadonlySet<string>;
}) {
    const t = useI18n();
    const [expanded, setExpanded] = useState(false);
    const [view, setView] = useState<StatsView>({kind: "overview"});
    const rootRef = useRef<HTMLDivElement>(null);
    /** The natural-size content wrapper the next box size is measured on. */
    const measureRef = useRef<HTMLDivElement>(null);

    const {diff, diffLoading, diffTotals, shells, subagents} = activity;
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
    const navKindRef = useRef<"expand" | "nav">("expand");
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
        navKindRef.current = "expand";
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
        pinCurrentSize();
        setExpanded(false);
        setView({kind: "overview"});
        setNavTick((n) => n + 1);
        setFlightsArmed(false);
    }, [pinCurrentSize]);

    const drill = useCallback((next: StatsView) => {
        navKindRef.current = "nav";
        pinCurrentSize();
        setView(next);
        setNavTick((n) => n + 1);
        setFlightsArmed(false);
    }, [pinCurrentSize]);

    const back = useCallback(() => {
        navKindRef.current = "nav";
        pinCurrentSize();
        setView({kind: "overview"});
        setNavTick((n) => n + 1);
        setFlightsArmed(false);
    }, [pinCurrentSize]);

    // Outside pointer-down / Escape collapse the panel (PopoverMenu's
    // capture-phase pattern).
    useEffect(() => {
        if (!expanded) return;
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
    }, [expanded, collapse]);

    // After every navigation (each handler pins the box first), measure
    // the incoming content's natural size and spring the box to it. The
    // measure wrapper MUST NOT shrink (shrink-0 below): a flex child
    // under the pinned container compresses, and measuring a compressed
    // element is what used to corrupt every target size. The first run
    // (mount) is skipped — the card enters at its natural size.
    const [navTick, setNavTick] = useState(0);
    const mountedRef = useRef(false);
    useLayoutEffect(() => {
        if (!mountedRef.current) {
            mountedRef.current = true;
            return;
        }
        const m = measureRef.current;
        if (!m) return;
        const r = m.getBoundingClientRect();
        const maxH = Math.max(240, window.innerHeight * 0.75);
        animateSizeTo({w: Math.ceil(r.width), h: Math.ceil(Math.min(r.height, maxH))});
    }, [expanded, view.kind, navTick, animateSizeTo]);

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
                        className={`shrink-0 ${expanded ? "w-[min(26rem,calc(100vw-24rem))]" : "w-max"}`}
                    >
                        <AnimatePresence mode="popLayout" initial={false}>
                            {!expanded ? (
                                <motion.button
                                    key="collapsed"
                                    type="button"
                                    initial={{opacity: 0}}
                                    animate={{opacity: 1, transition: springSnappy}}
                                    exit={{opacity: 0, transition: {duration: durationFast}}}
                                    onClick={expand}
                                    className="flex flex-col items-stretch gap-1 px-3 py-2.5 cursor-pointer rounded-[var(--radius-lg)] text-xs transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-stats-hover)]"
                                    style={{"--lum-stats-hover": colors.hoverOverlay} as React.CSSProperties}
                                    aria-label={t["Session activity"]}
                                >
                                    {diffTotals.files > 0 && (
                                        <span className="flex items-center justify-between gap-2">
                                            <Diff size={13} className="shrink-0 opacity-70"/>
                                            <DiffCountsBadge added={diffTotals.added} removed={diffTotals.removed}/>
                                        </span>
                                    )}
                                    {shells.length > 0 && (
                                        <span className="flex items-center justify-between gap-2">
                                            <SquareTerminal
                                                size={13}
                                                className={`shrink-0 opacity-70${runningShells > 0 ? " animate-pulse" : ""}`}
                                            />
                                            <StatCount
                                                finished={shells.length - runningShells}
                                                total={shells.length}
                                                label={t["Terminals"]}
                                            />
                                        </span>
                                    )}
                                    {subagents.length > 0 && (
                                        <span className="flex items-center justify-between gap-2">
                                            <Bot
                                                size={13}
                                                className={`shrink-0 opacity-70${runningSubagents > 0 ? " animate-pulse" : ""}`}
                                            />
                                            <StatCount
                                                finished={subagents.length - runningSubagents}
                                                total={subagents.length}
                                                label={t["Subagents"]}
                                            />
                                        </span>
                                    )}
                                </motion.button>
                            ) : (
                                <motion.div
                                    key="expanded"
                                    // No ENTER fade: a root opacity would dim
                                    // the flights inside. Entering content
                                    // fades itself (FadeIn); the panel's exit
                                    // still fades as a whole.
                                    exit={{opacity: 0, transition: {duration: durationFast}}}
                                    className="max-h-[75vh] flex flex-col"
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
                                                {t["Session activity"]}
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
                                        className="min-h-0 overflow-y-auto px-3 pb-3 flex flex-col gap-3"
                                        onPointerDown={() => setFlightsArmed(true)}
                                    >
                                        {view.kind === "overview" && (
                                            <>
                                                {showChanges && (
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
                                                )}
                                                {shells.length > 0 && (
                                                    <TerminalsSection
                                                        shells={shells}
                                                        colors={colors}
                                                        fadeDelay={contentFadeDelay}
                                                        flight={flightsArmed}
                                                        onOpenTerminal={(shell) => drill({kind: "terminal", shell})}
                                                    />
                                                )}
                                                {subagents.length > 0 && (
                                                    <SubagentsSection
                                                        subagents={subagents}
                                                        colors={colors}
                                                        fadeDelay={contentFadeDelay}
                                                        flight={flightsArmed}
                                                        onOpenSubagent={(sub) => drill({kind: "subagent", sub})}
                                                    />
                                                )}
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
