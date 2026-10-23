import {useCallback, useEffect, useMemo, useState} from "react";
import {Tab, Tabs} from "@heroui/react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {SessionStatsInfo} from "../../opencode/types.ts";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {useCatalog} from "../../opencode/catalogContext.tsx";
import {whileHoverTap} from "../../lib/motion.ts";
import {formatCost, formatTokens} from "../chat/usageStats.ts";
import {UsageDonut, UsageLegend, UsageLines, type HoverKey} from "./UsageCharts.tsx";
import SectionHeader from "./SectionHeader.tsx";
import {
    buildUsageSeries,
    dayWindows,
    niceTicks,
    pieSlices,
    seriesColor,
    type UsageRow,
} from "./usageOverview.ts";

/** The selectable window sizes, in days. */
const RANGES = [7, 30] as const;

/**
 * The settings' Usage pane: the model-share donut + legend on top, the
 * per-model daily-trend lines below (charts in UsageCharts.tsx, pure
 * shaping in usageOverview.ts). One stats query over the whole window
 * for the summary line + one query per LOCAL day for the per-model
 * matrix (the endpoint has no model-grouped daily series — see
 * api.sessionStats), all fired in parallel; a failed day window drops
 * out of its row, a failed summary degrades the header to the series'
 * own aggregate, and only a total failure shows the error state.
 */
export default function UsageSettings({api}: {api: OpencodeApi | null}) {
    const colors = useColors();
    const t = useI18n();
    const {models} = useCatalog();
    const [days, setDays] = useState<(typeof RANGES)[number]>(30);
    // Bumped by the retry button — remounts the load below.
    const [attempt, setAttempt] = useState(0);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [summary, setSummary] = useState<SessionStatsInfo | null>(null);
    const [series, setSeries] = useState<UsageRow[]>([]);
    const [hovered, onHover] = useState<HoverKey>(null);

    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        setLoading(true);
        setFailed(false);
        const windows = dayWindows(days, new Date());
        const range = {from: windows[0].from, to: windows[windows.length - 1].to};
        Promise.all([
            // The whole-window summary (top totals). A failure degrades
            // the header to the series' own aggregate — not fatal.
            api.sessionStats(range).catch(() => null),
            // One query per local day; each failure drops that day from
            // its rows (buildUsageSeries is null-tolerant).
            Promise.all(windows.map((w) => api.sessionStats(w).catch(() => null))),
        ]).then(([summaryRes, perWindow]) => {
            if (cancelled) return;
            const rows = buildUsageSeries(windows, perWindow);
            if (summaryRes == null && rows.length === 0) {
                setLoading(false);
                setFailed(true);
                logError("Usage overview: stats endpoint unreachable").catch(() => {});
                return;
            }
            setLoading(false);
            setSummary(summaryRes);
            setSeries(rows);
            logInfo(`Usage overview loaded: ${rows.length} models over ${days}d`).catch(() => {});
        }).catch((e) => {
            if (cancelled) return;
            setLoading(false);
            setFailed(true);
            logError(`Usage overview failed: ${e}`).catch(() => {});
        });
        return () => {
            cancelled = true;
        };
    }, [api, days, attempt]);

    const retry = useCallback(() => setAttempt((n) => n + 1), []);

    // Display rows: series already folds variants and sorts by usage;
    // labels resolve to the catalog's proper names (ModelChangeDivider's
    // resolution — "GLM 5.3" reads, "zhipu-coding-plan/glm-5.3"
    // doesn't), a model that left the catalog falling back to its bare
    // modelID.
    const displaySeries = useMemo(() => {
        return series.map((r) => {
            const slash = r.key.indexOf("/");
            const providerID = r.key.slice(0, slash);
            const modelID = slash >= 0 ? r.key.slice(slash + 1) : r.key;
            const name = models.find((m) => m.providerID === providerID && m.modelID === modelID)?.name;
            return {...r, label: name ?? modelID};
        });
    }, [series, models]);
    const slices = useMemo(() => pieSlices(displaySeries), [displaySeries]);
    const rowColors = useMemo(() => displaySeries.map((_, i) => seriesColor(i)), [displaySeries]);
    const lines = useMemo(
        () => displaySeries.map((r, i) => ({key: r.key, color: seriesColor(i), perDay: r.perDay})),
        [displaySeries],
    );
    const labels = useMemo(() => dayWindows(days, new Date()).map((w) => w.label), [days]);
    const ticks = useMemo(
        () => niceTicks(Math.max(0, ...series.flatMap((r) => r.perDay), 0)),
        [series],
    );

    // The header's totals prefer the whole-window summary; when it
    // failed, fall back to the matrix's own aggregate.
    const totalTokens_ = summary ? formatTokens(summary.tokens.input + summary.tokens.output + summary.tokens.reasoning + summary.tokens.cache.read + summary.tokens.cache.write) : null;
    const totalFromSeries = displaySeries.reduce((s, r) => s + r.tokens, 0);
    const costLabel = formatCost(summary?.cost ?? displaySeries.reduce((s, r) => s + r.cost, 0));

    return (
        <div className="flex-1 min-h-0 overflow-y-auto px-8 py-8 lum-fade-top lum-fade-bottom lum-fade-md">
            {/* Range switch + summary line. The range control is the
             * HeroUI Tabs in its horizontal segmented form (the sidebar
             * mode switcher's twin — sliding indicator, focus ring
             * scrubbed by .lum-usage-tabs in main.css). */}
            <div className="flex items-center justify-between gap-4 pb-6">
                <Tabs
                    aria-label={t["Daily usage"]}
                    className="shrink-0"
                    selectedKey={String(days)}
                    onSelectionChange={(key) => {
                        const n = Number(key);
                        if (n === 7 || n === 30) setDays(n);
                    }}
                >
                    <Tabs.List
                        aria-label={t["Daily usage"]}
                        className="lum-usage-tabs rounded-full"
                        style={{background: "var(--lum-neutral-fill)"}}
                    >
                        {RANGES.map((n) => (
                            <Tab key={n} id={String(n)}>
                                {n === 7 ? t["Last 7 days"] : t["Last 30 days"]}
                                <Tabs.Indicator/>
                            </Tab>
                        ))}
                    </Tabs.List>
                </Tabs>
                {loading ? (
                    <span className="lum-loading"><span/><span/><span/></span>
                ) : failed ? (
                    <span className="text-xs" style={{color: "var(--color-danger)"}}>{t["Failed to load usage"]}</span>
                ) : (
                    <div className="flex items-baseline gap-3 text-xs tabular-nums min-w-0" style={{color: colors.inactiveText}}>
                        <span>
                            <span style={{color: colors.textPrimary, fontWeight: 600}}>{totalTokens_ ?? formatTokens(totalFromSeries)}</span>{" "}{t["Total tokens"]}
                        </span>
                        {costLabel && <span>{costLabel} {t["Cost"]}</span>}
                        {summary && <span>{summary.sessions.toLocaleString()} {t["Sessions"]}</span>}
                        {summary && <span>{summary.steps.toLocaleString()} {t["Steps"]}</span>}
                    </div>
                )}
            </div>

            {loading ? (
                <div className="flex-1 flex items-center justify-center py-16">
                    <span className="lum-loading"><span/><span/><span/></span>
                </div>
            ) : failed ? (
                <div className="flex flex-col items-center gap-3 py-16">
                    <span className="text-sm" style={{color: colors.inactiveText}}>{t["Failed to load usage"]}</span>
                    <button
                        type="button"
                        {...whileHoverTap}
                        onClick={retry}
                        className="h-8 px-4 rounded-[var(--radius-sm)] text-xs font-medium cursor-pointer"
                        style={{background: colors.activeOverlay, color: colors.textPrimary}}
                    >
                        {t["Retry"]}
                    </button>
                </div>
            ) : series.length === 0 ? (
                <div className="flex items-center justify-center py-16 text-sm" style={{color: colors.inactiveText}}>
                    {t["No usage yet"]}
                </div>
            ) : (
                <>
                    {/* Model share — donut + legend, one hover channel. */}
                    <div className="flex items-center gap-6 pb-8">
                        <UsageDonut
                            slices={slices}
                            colors={rowColors}
                            hovered={hovered}
                            onHover={onHover}
                            totalLabel={t["Total tokens"]}
                        />
                        <UsageLegend rows={displaySeries} colors={rowColors} hovered={hovered} onHover={onHover}/>
                    </div>

                    {/* Daily trend. */}
                    <SectionHeader label={t["Daily usage"]}/>
                    <UsageLines labels={labels} series={lines} ticks={ticks} hovered={hovered} onHover={onHover}/>
                </>
            )}
        </div>
    );
}
