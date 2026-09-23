import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import {AnimatePresence, motion} from "framer-motion";
import {Bot, ChevronLeft, ChevronUp, Diff, SquareTerminal} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {durationFast, springSoft, springSnappy} from "../../lib/motion.ts";
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
 * - The BOX animates its REAL width/height (pin → measure the new
 *   content → spring between pixel sizes → release to auto). No
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
    // A hand-rolled spring drives the container's REAL style.width/height
    // (validated against a browser repro): framer's animate proved
    // unreliable for this — values apply on animation frames (so a pin
    // set in the same tick as a content swap never reached the DOM and
    // the animation's from-value became the NEW content's auto size),
    // and its auto-target handling polluted measurements. Both problems
    // compounded with the true root cause below.
    // SLIGHTLY UNDERDAMPED + snap-finish (tuned by simulation): the
    // spring races to ~97% in ~180ms, and the settle check lands it
    // exactly from 3px out — an (over/under)damped tail otherwise decays
    // exponentially, and those last pixels crawl for another 250ms,
    // which reads as the animation being stuck.
    const SPRING = {stiffness: 500, damping: 33, mass: 0.8} as const;
    const sizeAnimRef = useRef<{
        raf: number;
        w: number;
        h: number;
        vw: number;
        vh: number;
        to: {w: number; h: number};
        last: number;
    } | null>(null);

    const cancelSizeAnim = useCallback(() => {
        if (sizeAnimRef.current) {
            cancelAnimationFrame(sizeAnimRef.current.raf);
            sizeAnimRef.current = null;
        }
    }, []);

    /** Freeze the container at its CURRENT pixel size — imperative and
     *  synchronous, so the pin holds before React's next commit swaps
     *  the content. FRACTIONAL by design (getBoundingClientRect, not the
     *  integer offsetWidth): rounding the pin up/down fabricates a 1px
     *  delta against the ceil'd measurement target, and a fake width
     *  spring on a width that never changed reads as horizontal jitter
     *  under the right-anchored layout. React never removes these
     *  properties (they're absent from the React style prop); the spring
     *  overwrites and finally releases them. */
    const pinCurrentSize = useCallback(() => {
        const el = rootRef.current;
        if (!el) return;
        cancelSizeAnim();
        const r = el.getBoundingClientRect();
        el.style.width = `${r.width}px`;
        el.style.height = `${r.height}px`;
    }, [cancelSizeAnim]);

    /** Spring the container's width/height to a target; on settle the
     *  inline properties are released so live content growth (a diff
     *  refresh adding rows, terminal output) resizes the card naturally.
     *  Per axis, a target within 2px of the current size is ADOPTED as
     *  the current value — animating a sub-2px delta is invisible at
     *  best and jitter at worst. */
    const animateSizeTo = useCallback((to: {w: number; h: number}) => {
        const el = rootRef.current;
        if (!el) return;
        cancelSizeAnim();
        const r = el.getBoundingClientRect();
        const anim = {
            raf: 0,
            w: r.width,
            h: r.height,
            vw: 0,
            vh: 0,
            to: {
                w: Math.abs(r.width - to.w) < 2 ? r.width : to.w,
                h: Math.abs(r.height - to.h) < 2 ? r.height : to.h,
            },
            last: performance.now(),
        };
        sizeAnimRef.current = anim;
        const {stiffness: k, damping: c, mass: m} = SPRING;
        const step = (now: number) => {
            const cur = sizeAnimRef.current;
            if (!cur) return;
            const dt = Math.min(0.05, (now - cur.last) / 1000);
            cur.last = now;
            cur.vw += ((-k * (cur.w - cur.to.w) - c * cur.vw) / m) * dt;
            cur.vh += ((-k * (cur.h - cur.to.h) - c * cur.vh) / m) * dt;
            cur.w += cur.vw * dt;
            cur.h += cur.vh * dt;
            // Snap-finish: the spring's last pixels decay exponentially —
            // waiting for sub-pixel accuracy lets the box visibly crawl.
            // Within 5px at ≤250px/s the remaining gap closes in under
            // five frames: land exactly (tuned by simulation — 217ms
            // total, ~80ms of tail after the 90% mark, no overshoot).
            const settled =
                Math.abs(cur.w - cur.to.w) < 5 &&
                Math.abs(cur.h - cur.to.h) < 5 &&
                Math.abs(cur.vw) < 250 &&
                Math.abs(cur.vh) < 250;
            if (settled) {
                el.style.removeProperty("width");
                el.style.removeProperty("height");
                sizeAnimRef.current = null;
                return;
            }
            el.style.width = `${cur.w}px`;
            el.style.height = `${cur.h}px`;
            cur.raf = requestAnimationFrame(step);
        };
        anim.raf = requestAnimationFrame(step);
    }, [cancelSizeAnim]);

    useEffect(() => cancelSizeAnim, [cancelSizeAnim]);

    // What mounted the current panel content. A card EXPAND wants new
    // content to wait while the box grows; an in-panel navigation (drill/
    // back) must swap near-instantly — the old view is gone in 150ms, and
    // a delayed successor reads as a blank flash.
    const navKindRef = useRef<"expand" | "nav">("expand");
    /** Row flight layoutIds are ARMED on pointer-down: rows mount bare
     *  (mount-time pairing against framer's stale registry boxes is what
     *  produced phantom/wrong-origin flights), and arming a beat before
     *  the drill click unmounts them means their boxes are still stored
     *  for the header titles to fly from. */
    const [flightsArmed, setFlightsArmed] = useState(false);
    const contentFadeDelay = navKindRef.current === "expand" ? 0.15 : 0;

    const expand = useCallback(() => {
        navKindRef.current = "expand";
        pinCurrentSize();
        setExpanded(true);
        setNavTick((n) => n + 1);
        setFlightsArmed(false);
        activity.refreshDiff();
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
    // the expanded panel wants real elevation.
    const shadowCollapsed = "0 1px 3px rgba(0,0,0,0.06)";
    const surfaceStyle = {
        background: "var(--color-elevated)",
        border: `1px solid ${colors.glassBorder}`,
        color: colors.dark ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.88)",
    } as const;

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
                    animate={{
                        opacity: 1,
                        y: 0,
                        boxShadow: expanded ? colors.elevationShadow : shadowCollapsed,
                    }}
                    exit={{opacity: 0, y: 8, transition: {duration: durationFast}}}
                    transition={springSoft}
                    // Content anchored top-right: it holds still in
                    // viewport space while the box grows around it (no
                    // clip — flights cross the growing edge in the open).
                    className="absolute right-4 top-4 z-30 rounded-[var(--radius-lg)] select-none flex justify-end items-start"
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
                                        <FadeIn className="shrink-0">
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
