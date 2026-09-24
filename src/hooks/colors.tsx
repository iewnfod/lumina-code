import {createContext, useContext, type ReactNode} from "react";
import type {SurfaceColors} from "./surfaceColors.ts";

/**
 * The app-wide SurfaceColors context. App derives the palette ONCE from
 * the effective background (useSurfaceColors) and provides it here;
 * every component reads it with useColors() instead of threading a
 * `colors` prop through every level — adding a palette field no longer
 * touches component signatures.
 *
 * Components that derive from a DIFFERENT background (none today) keep
 * calling useSurfaceColors(bg) directly.
 */
const ColorsContext = createContext<SurfaceColors | null>(null);

export function ColorsProvider({colors, children}: {colors: SurfaceColors; children: ReactNode}) {
    return <ColorsContext.Provider value={colors}>{children}</ColorsContext.Provider>;
}

/** The chrome palette App provided. Throws outside a provider. */
export function useColors(): SurfaceColors {
    const colors = useContext(ColorsContext);
    if (colors === null) throw new Error("useColors() requires <ColorsProvider> above in the tree");
    return colors;
}
