import {useEffect, type RefObject} from "react";

/**
 * Capture-phase outside-pointerdown + Escape dismissal — the shared
 * "click away / press Escape to close" behavior of PopoverMenu and the
 * stats panel's overlay collapse. Listeners only attach while `active`;
 * both run in the CAPTURE phase so a click that opens another surface
 * closes this one first.
 *
 * `exempt` spares pointerdowns on qualifying targets (the stats panel
 * spares its drill rows and any open modal — clicking through to another
 * surface must not collapse the panel under it). `escapeBusy` reports
 * whether Escape currently belongs to someone else (an open modal's own
 * handler); when true the Escape press is ignored here.
 */
export function useOutsideDismiss(
    ref: RefObject<HTMLElement | null>,
    active: boolean,
    onDismiss: () => void,
    opts?: {
        exempt?: (target: Element) => boolean;
        escapeBusy?: () => boolean;
    },
): void {
    useEffect(() => {
        if (!active) return;
        const onPointerDown = (e: PointerEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                const el = e.target as Element;
                if (opts?.exempt && typeof el.closest === "function" && opts.exempt(el)) {
                    return;
                }
                onDismiss();
            }
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !opts?.escapeBusy?.()) onDismiss();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
        // onDismiss identity changes should not rebind mid-gesture; read
        // the latest via the closure the effect was created with — callers
        // pass stable callbacks (setState / useCallback).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, onDismiss]);
}
