import {ArrowUp, Paperclip, Square} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import ToolbarButton from "./ToolbarButton.tsx";
import type {ContextUsage} from "../chat/usageStats.ts";
import {ComposerSettingsControls} from "./ComposerSettingsControls.tsx";
import {ComposerSelectors} from "./ComposerSelectors.tsx";

/**
 * The composer's bottom toolbar: attachments + mode on the left (plus the
 * project picker until the conversation starts); usage ring, the MERGED
 * model picker (model list + the current model's thinking-depth slider —
 * one option) and send/stop on the right. Extracted from ChatInput so
 * the composer shell reads as layout and this file as picker wiring.
 *
 * The settings controls (mode + project/branch pickers) and the selectors
 * cluster live in their own exported components
 * (ComposerSettingsControls / ComposerSelectors) because MOBILE's welcome
 * screen hosts them OUTSIDE the composer: a phone row cannot fit five
 * labeled controls, so the box keeps only attach + send (`minimal`) and
 * the whole cluster renders below it (WelcomeScreen). In-session toolbars
 * stay full. `minimal` also drops the `.lum-tb-selectors` wrapper (an
 * empty one would still claim a full row in the narrow tier) and wears
 * `.lum-toolbar-plain` so the send button keeps its right-edge spring at
 * any width (main.css).
 */
export default function ComposerToolbar({
    disabled,
    busy,
    canSend,
    sendBlocked = false,
    onAttach,
    onSend,
    onInterrupt,
    conversationStarted,
    contextUsage = null,
    minimal = false,
}: {
    /** No connection yet. */
    disabled: boolean;
    busy: boolean;
    /** The editor holds non-empty content (send enabled). */
    canSend: boolean;
    /** DEV's no-default-directory rule: the welcome composer has no
     *  project staged yet — the send button shows the "choose a project
     *  directory" hint instead of sending. */
    sendBlocked?: boolean;
    onAttach: () => void;
    onSend: () => void;
    onInterrupt: () => void;
    /** False until the conversation has its first message — shows the
     *  project picker (welcome screen and freshly created sessions). */
    conversationStarted: boolean;
    /** The session's current context reading (last measured step). */
    contextUsage?: ContextUsage | null;
    /** Reduce the toolbar to attach + send — MOBILE's welcome screen
     *  hosts ComposerSettingsControls + ComposerSelectors below the
     *  composer instead (five labeled controls cannot fit a phone row).
     *  The in-session toolbar always stays full. */
    minimal?: boolean;
}) {
    const t = useI18n();

    /** Left cluster: attachments, plus (full toolbars) mode and the
     *  pre-session project/branch pickers. */
    const actions = (
        <>
            <ToolbarButton
                icon={<Paperclip size={14}/>}
                title={t["Add attachment"]}
                disabled={disabled}
                onClick={onAttach}
            />
            {!minimal && <ComposerSettingsControls conversationStarted={conversationStarted}/>}
        </>
    );

    {/* One send/stop slot: text ready → SEND (mid-run it QUEUES —
     * promptQueue.ts — instead of steering the turn; the title
     * says so), no text while running → STOP, idle and empty →
     * send stays disabled. A BLOCKED send (dev without a project)
     * renders the disabled button with the choose-a-directory hint. */}
    const sendSlot = !disabled && canSend && !sendBlocked ? (
        <ToolbarButton
            icon={<ArrowUp size={14}/>}
            title={busy ? t["Queue message"] : t["Send"]}
            onClick={onSend}
        />
    ) : busy ? (
        <ToolbarButton
            icon={<Square size={14}/>}
            title={t["Stop"]}
            onClick={onInterrupt}
        />
    ) : (
        <ToolbarButton
            icon={<ArrowUp size={14}/>}
            title={sendBlocked ? t["Choose a project directory first"] : t["Send"]}
            disabled
            onClick={onSend}
        />
    );

    // The toolbar's row count is WIDTH-DRIVEN, not device-driven: the
    // toolbar is its own inline-size container and main.css retiers it —
    // wide: one row (actions | spring | selectors | send); narrow
    // (< 30rem, narrow desktop windows): the selectors claim the top
    // line right-aligned, actions + send share the bottom one (send
    // keeps the thumb zone). MOBILE is one row at EVERY width
    // (mobile.css neutralizes the tier; labels truncate instead). A
    // minimal toolbar (mobile welcome) has no selectors, so
    // `.lum-toolbar-plain` pins the send spring at every width instead.
    // See the .lum-toolbar block in main.css (the §3.7 container-query
    // doctrine, same as .lum-column).
    return (
        <div
            className={`flex flex-wrap items-center gap-0.5 px-2 pb-2 pt-0.5 lum-toolbar${
                minimal ? " lum-toolbar-plain" : ""
            }`}
        >
            <div className="lum-tb-actions flex items-center gap-0.5 min-w-0">{actions}</div>
            {!minimal && (
                <div className="lum-tb-selectors flex items-center gap-0.5 min-w-0">
                    <ComposerSelectors
                        conversationStarted={conversationStarted}
                        contextUsage={contextUsage}
                    />
                </div>
            )}
            <div className="lum-tb-send">{sendSlot}</div>
        </div>
    );
}
