import {Switch as HeroUISwitch} from "@heroui/react";

/**
 * The settings panes' boolean toggle — the HeroUI Switch (default md
 * size, 20px track) whose checked track reads the library's --accent,
 * pinned to the brand cinnabar in main.css. COMPOUND anatomy: a bare
 * <Switch/> renders nothing — the Content (the clickable button) must
 * wrap the Control (track) and Thumb explicitly. The wrapper keeps the
 * old local signature ({checked, label, onChange}) so every pane
 * consumes it unchanged; no text label inside — aria-label only.
 */
export default function Switch({checked, label, onChange}: {
    checked: boolean;
    label: string;
    onChange: (checked: boolean) => void;
}) {
    return (
        <HeroUISwitch isSelected={checked} aria-label={label} onChange={onChange}>
            <HeroUISwitch.Content>
                <HeroUISwitch.Control>
                    <HeroUISwitch.Thumb/>
                </HeroUISwitch.Control>
            </HeroUISwitch.Content>
        </HeroUISwitch>
    );
}
