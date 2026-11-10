import {useEffect, useMemo, useState} from "react";
import {RotateCcw} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {setShortcutRecording} from "../../hooks/useKeyboardShortcuts.ts";
import {resetShortcutBindings, setShortcutBinding, useShortcutBindings} from "../../hooks/useShortcutBindings.ts";
import {isMacOS} from "../../lib/platform.ts";
import {
    chordFromEvent,
    findConflicts,
    formatChord,
    isBindableChord,
    resolveBindings,
    SHORTCUTS,
    type ShortcutAction,
} from "../../lib/shortcuts.ts";
import Button from "../ui/Button.tsx";
import SettingRow from "./SettingRow.tsx";

/**
 * The Keyboard Shortcuts pane: one row per registry action (label +
 * keycap + per-row reset), live re-binding by RECORDING, and conflict
 * warnings. Everything derives from lib/shortcuts.ts (the registry +
 * chord algebra) over the persisted override store.
 *
 * RECORDING: clicking a keycap arms that row — the pane then captures
 * keydown on document (capture phase, everything consumed) while the
 * global listener stands down (setShortcutRecording). The next valid
 * chord commits immediately; Esc cancels; Backspace/Delete restores the
 * action's DEFAULT. Unbindable presses (plain keys, pure modifiers, the
 * reserved text/reload chords) flash a notice and keep waiting. While
 * armed, conflicts are permitted — both rows then carry the warning and
 * the FIRST registry action wins at runtime (lib/shortcuts.ts'
 * documented rule).
 */

export default function ShortcutsSettings() {
    const t = useI18n();
    const colors = useColors();
    const overrides = useShortcutBindings();
    const bindings = useMemo(() => resolveBindings(overrides), [overrides]);
    const conflicts = useMemo(() => findConflicts(bindings), [bindings]);
    const isMac = isMacOS();

    /** The action whose row is armed for recording, null when idle. */
    const [recording, setRecording] = useState<ShortcutAction | null>(null);
    /** The last refused chord while recording (reserved/unbindable) —
     *  shown as the row's notice until a valid chord or cancel. */
    const [refused, setRefused] = useState<string | null>(null);

    // The recorder: captures EVERYTHING while armed (the global shortcut
    // listener is gated by the same flag, so the combination being
    // recorded cannot fire its current action mid-capture).
    useEffect(() => {
        if (recording === null) return;
        setShortcutRecording(true);
        const onKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") {
                setRecording(null);
                setRefused(null);
                return;
            }
            if (e.key === "Backspace" || e.key === "Delete") {
                setShortcutBinding(recording, null); // restore the default
                setRecording(null);
                setRefused(null);
                return;
            }
            const chord = chordFromEvent(e, isMac);
            if (chord === null) return; // plain key / modifier / IME — keep waiting
            if (!isBindableChord(chord)) {
                setRefused(chord);
                return;
            }
            setShortcutBinding(recording, chord);
            setRecording(null);
            setRefused(null);
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
            setShortcutRecording(false);
        };
    }, [recording, isMac]);

    /** The row label for a conflict notice: the registry-first action
     *  that OWNS the shared chord (the runtime winner). */
    const conflictWinner = (action: ShortcutAction): string | null => {
        const bucket = conflicts.get(bindings[action]);
        if (!bucket || bucket.length < 2) return null;
        const winner = bucket[0];
        return winner === action ? null : t[SHORTCUTS.find((d) => d.id === winner)!.labelKey];
    };

    const keycapBase =
        "h-8 min-w-14 px-2.5 rounded-[var(--radius-sm)] border font-medium text-xs " +
        "cursor-pointer select-none transition-colors duration-[var(--duration-fast)]";

    return (
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 lum-fade-top lum-fade-bottom lum-fade-md">
            <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-0.5">
                    <p className="text-xs opacity-55">{t["Click a key to rebind it"]}</p>
                    <p className="text-xs opacity-55">{t["Recording hint"]}</p>
                </div>

                {SHORTCUTS.map((def) => {
                    const customized = overrides[def.id] !== undefined;
                    const chord = bindings[def.id];
                    const armed = recording === def.id;
                    const winner = conflictWinner(def.id);
                    return (
                        <div key={def.id} className="flex flex-col gap-1">
                            <SettingRow label={t[def.labelKey]}>
                                <div className="flex items-center gap-1.5">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setRefused(null);
                                            setRecording(armed ? null : def.id);
                                        }}
                                        className={keycapBase}
                                        style={{
                                            fontFamily: "var(--font-mono, ui-monospace, monospace)",
                                            background: armed ? colors.accentOverlay : colors.recessedBg,
                                            borderColor: armed ? colors.textPrimary : colors.glassBorder,
                                        }}
                                    >
                                        {armed ? t["Recording…"] : formatChord(chord, isMac)}
                                    </button>
                                    {customized && (
                                        <button
                                            type="button"
                                            onClick={() => setShortcutBinding(def.id, null)}
                                            className="h-8 w-8 flex items-center justify-center rounded-[var(--radius-sm)] text-xs cursor-pointer hover:bg-[var(--lum-wash)]"
                                            style={{color: colors.inactiveText}}
                                            aria-label={t["Reset"]}
                                        >
                                            <RotateCcw size={14}/>
                                        </button>
                                    )}
                                </div>
                            </SettingRow>
                            {(armed && refused) || winner ? (
                                <p
                                    className="text-xs self-end"
                                    style={{color: "var(--color-danger-text)"}}
                                >
                                    {armed && refused
                                        ? `${t["Reserved combination"]} (${formatChord(refused, isMac)})`
                                        : t["Already bound to {action}"].replace("{action}", winner ?? "")}
                                </p>
                            ) : null}
                        </div>
                    );
                })}

                <div className="flex justify-end pt-2">
                    <Button label={t["Reset all"]} onClick={resetShortcutBindings}/>
                </div>
            </div>
        </div>
    );
}
