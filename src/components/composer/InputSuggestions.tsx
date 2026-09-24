import {useEffect, useRef} from "react";
import {Terminal} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import type {OpencodeCommand} from "../../opencode/types.ts";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import type {FileMentionData} from "./FileMentionNode.tsx";
import {COMMAND_MENTION_COLOR} from "./CommandMentionNode.tsx";

/** One row of the composer's inline autocomplete (`/` commands, `@` files). */
export type SuggestionItem =
    | {kind: "command"; command: OpencodeCommand}
    | {kind: "file"; file: FileMentionData};

/**
 * Floating suggestion list anchored above the composer textarea. Keyboard
 * navigation lives in ChatInput (it owns the textarea's key events); this
 * component only renders and scroll-keeps the highlighted row. Rows use
 * onMouseDown so clicking does not blur the textarea first.
 */
export default function InputSuggestions({
    items,
    selected,
    emptyLabel,
    onSelect,
}: {
    items: SuggestionItem[];
    /** Highlighted row index (owned by ChatInput, clamped there). */
    selected: number;
    /** Shown when a trigger is active but nothing matches. */
    emptyLabel: string;
    onSelect: (item: SuggestionItem) => void;
}) {
    const colors = useColors();
    const listRef = useRef<HTMLDivElement>(null);

    // Keep the keyboard-highlighted row visible while arrowing through.
    useEffect(() => {
        listRef.current
            ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
            ?.scrollIntoView({block: "nearest"});
    }, [selected]);

    return (
        <div
            ref={listRef}
            className="absolute bottom-full left-0 right-0 z-50 max-h-64 overflow-y-auto rounded-[var(--radius-md)] py-1 mb-1.5"
            style={{
                background: "var(--color-elevated)",
                border: `1px solid ${colors.glassBorder}`,
                boxShadow: colors.elevationShadow,
                color: colors.dark ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.88)",
            }}
        >
            {items.length === 0 ? (
                <div className="px-3 py-2 text-xs opacity-50">{emptyLabel}</div>
            ) : (
                items.map((item, i) => {
                    const key = item.kind === "command" ? `c:${item.command.name}` : `f:${item.file.absolute}`;
                    return (
                        <button
                            key={key}
                            type="button"
                            data-index={i}
                            onMouseDown={(e) => {
                                e.preventDefault(); // keep editor focus/caret
                                onSelect(item);
                            }}
                            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs cursor-pointer transition-colors duration-[var(--duration-fast)]"
                            style={i === selected ? {background: colors.activeOverlay} : undefined}
                        >
                            {item.kind === "command" ? (
                                // Same accent the inserted command mention
                                // will carry, so a picked row previews its
                                // final look.
                                <Terminal size={13} className="shrink-0" style={{color: COMMAND_MENTION_COLOR}}/>
                            ) : (
                                // The same icon the inserted mention will
                                // carry, so a picked row previews its
                                // final look.
                                <img src={fileIconUrl(item.file.relative)} alt="" className="w-4 h-4 shrink-0"/>
                            )}
                            <span className="shrink-0 font-medium">
                                {item.kind === "command" ? `/${item.command.name}` : fileName(item.file.relative)}
                            </span>
                            <span className="truncate opacity-50 leading-normal">
                                {item.kind === "command" ? item.command.description ?? "" : dirName(item.file.relative)}
                            </span>
                        </button>
                    );
                })
            )}
        </div>
    );
}

function fileName(path: string): string {
    const base = path.split("/").pop() ?? path;
    return base || path;
}

function dirName(path: string): string {
    const parts = path.split("/");
    parts.pop();
    return parts.join("/");
}
