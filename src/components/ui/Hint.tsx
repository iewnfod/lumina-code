import type {ReactNode} from "react";
import {Tooltip} from "@heroui/react";

/**
 * THE hover-hint wrapper: a HeroUI tooltip around an existing element —
 * the single replacement for native `title` attributes (whose OS-drawn
 * tooltips don't follow the app's surface language). The HeroUI tooltip
 * base already pads the bubble on all four sides (p-2), so content stays
 * clear of the horizontal edges.
 *
 * A falsy `label` renders the child untouched — call sites gate the hint
 * on whether there is anything to say (a value that exists, a popover
 * that isn't already open, …). Timings match TitleBar's original
 * tooltip: quick to appear, instant to leave.
 *
 * `className` styles the trigger wrapper (an inline-block div that
 * becomes the flex item in flex parents): sizing classes such as
 * flex-1/min-w-0/max-w move onto it from the wrapped element.
 */
export default function Hint({label, className, children}: {
    label: string | null | undefined;
    className?: string;
    children: ReactNode;
}) {
    if (!label) return <>{children}</>;
    return (
        <Tooltip delay={300} closeDelay={0}>
            <Tooltip.Trigger className={className}>
                {children}
            </Tooltip.Trigger>
            <Tooltip.Content>
                <p className="text-xs px-2 max-w-64 break-words">{label}</p>
            </Tooltip.Content>
        </Tooltip>
    );
}
