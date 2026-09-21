import type {CSSProperties, ReactNode} from "react";
import {isMacOS} from "../../lib/platform.ts";

/**
 * Clips its children to a rounded-rectangle shape, so the corners are
 * transparent and whatever sits behind this component shows through. This is
 * how the content area gets its rounded inner corners: a chrome glass layer
 * underneath, the surface (wrapped here) on top with the corners cut away.
 * Ported as-is from lumina-terminal.
 */

export interface MaskedSurfaceProps {
    children: ReactNode;
    /** Corner radius in px. Defaults to the --radius-lg token (14). */
    radius?: number;
    className?: string;
    style?: CSSProperties;
}

export default function MaskedSurface({
    children,
    radius,
    className = "",
    style,
}: MaskedSurfaceProps) {
    // Read the default radius from the design token once; fall back to 14
    // (the literal --radius-lg value) if the var isn't resolvable yet.
    const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--radius-lg")
        .trim();
    const parsed = parseFloat(raw);
    const r = radius ?? (Number.isFinite(parsed) && parsed > 0 ? parsed : 14);

    return (
        <div
            className={className}
            style={{
                borderRadius: r,
                overflow: "hidden",
                // WKWebView can promote promoted layers above an ancestor
                // overflow clip on its first compositing pass. A WebKit mask
                // forces that clip into the compositor immediately; without it
                // the rounded corners appear only after a native window resize.
                ...(isMacOS()
                    ? {WebkitMaskImage: "-webkit-radial-gradient(white, black)"}
                    : {}),
                ...style,
            }}
        >
            {children}
        </div>
    );
}
