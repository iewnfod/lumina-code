import {memo, useMemo} from "react";
import {DiffView, DiffModeEnum} from "@git-diff-view/react";
import type {CSSProperties} from "react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import "@git-diff-view/react/styles/diff-view.css";
import "./diffView.css";

/** Max NEW-file line number across hunk headers ("@@ -l,s +l,s @@"),
 *  as a digit count — sizes the gutter at 1ch per digit (exact in a
 *  mono font; see diffView.css). The lib's own --diff-aside-width-- is
 *  floored at 40px, which is why the gutter reads wide. */
function gutterDigits(hunks: string[]): number {
    let max = 0;
    for (const hunk of hunks) {
        const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(hunk);
        if (m) max = Math.max(max, Number(m[1]) + Number(m[2] ?? 1) - 1);
    }
    // Malformed/no headers: fall back to 3 digits rather than a
    // zero-width gutter.
    return max > 0 ? String(max).length : 3;
}

/**
 * git-diff-view (@git-diff-view/react) rendering, shared by the tool
 * cards' diff body and the stats panel's file diff (ChangesSection).
 * Unified mode — the transcript column and the stats panel are both
 * too narrow for split; built-in lowlight syntax highlighting keyed off
 * the file name; wrap on; theme from the surface's derived luminance.
 *
 * Hunks are precomputed in the pure layer (toolDiff.ts's patchHunks /
 * fragmentHunks / toolHunksFor) and memoized by callers — DiffView
 * rebuilds its internal DiffFile whenever the data prop's identity
 * changes, so callers must hand it a stable array.
 */
export const DiffViewBody = memo(function DiffViewBody({
    hunks,
    fileName,
    colors,
}: {
    /** Unified-diff hunk strings (each starting with its @@ header). */
    hunks: string[];
    /** File name — drives the highlighter's language detection. */
    fileName?: string | null;
    colors: SurfaceColors;
}) {
    const digits = useMemo(() => gutterDigits(hunks), [hunks]);
    return (
        <div className="lum-diff-view" style={{"--lum-diff-digits": digits} as CSSProperties}>
            <DiffView
                data={{
                    oldFile: {fileName: fileName ?? undefined},
                    newFile: {fileName: fileName ?? undefined},
                    hunks,
                }}
                diffViewMode={DiffModeEnum.Unified}
                diffViewTheme={colors.dark ? "dark" : "light"}
                diffViewHighlight
                diffViewWrap
            />
        </div>
    );
});

export default DiffViewBody;
