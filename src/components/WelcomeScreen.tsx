import type {OpencodeApi} from "../opencode/api.ts";
import type {
    ComposerAttachment,
    ComposerFileRef,
    OpencodeAgent,
    OpencodeModel,
    PendingCommand,
    SessionModelRef,
} from "../opencode/types.ts";
import ChatPlaceholder from "./ChatPlaceholder.tsx";
import ChatInput from "./composer/ChatInput.tsx";

/**
 * The welcome screen shown while no session is open: greeting/logo, a
 * connection-status line when relevant, and the centered composer. The
 * composer's selections are staged (App's useSessionFlow) — the session
 * is created server-side only when the first message is sent.
 */
export default function WelcomeScreen({
    foregroundColor,
    subtitle,
    disabled,
    onSend,
    agents,
    models,
    catalogOnly,
    agent,
    model,
    onAgentChange,
    onModelChange,
    api,
    directory,
    onDirectoryChange,
    onOpenModelConfig,
}: {
    foregroundColor: string;
    /** Status line under the greeting — connection state, when relevant. */
    subtitle?: string;
    /** No connection yet. */
    disabled: boolean;
    onSend: (text: string, files: ComposerAttachment[], fileRefs: ComposerFileRef[], command: PendingCommand | null) => void;
    agents: OpencodeAgent[];
    models: OpencodeModel[];
    /** No authenticated provider of the user's own — the model picker
     *  shows its "nothing configured" entry above the free catalog. */
    catalogOnly: boolean;
    agent: string;
    model: SessionModelRef | null;
    onAgentChange: (agent: string) => void;
    onModelChange: (model: SessionModelRef) => void;
    api: OpencodeApi | null;
    directory: string | null;
    onDirectoryChange: (directory: string | null) => void;
    /** Opens the settings modal on its Model tab (model/provider config). */
    onOpenModelConfig: () => void;
}) {
    return (
        <div className="lum-enter h-full min-w-0 flex-1">
            {/* No horizontal padding here — the composer column's shared
                .lum-column owns the gutters, keeping it aligned with
                ChatView's columns across the welcome → session swap. */}
            <div className="flex flex-col h-full w-full items-center justify-center gap-6 py-6">
                {/* Same responsive column box as the composer below, so the
                    greeting's wrap width tracks the window (wide tier lifts
                    the cap for long greetings; narrow windows keep the
                    roomy gutters as edge breathing room) and stays aligned
                    with the composer at every width. */}
                <div className="lum-column">
                    <ChatPlaceholder
                        foregroundColor={foregroundColor}
                        subtitle={subtitle}
                        directory={directory}
                    />
                </div>
                <div className="lum-column">
                    <ChatInput
                        disabled={disabled}
                        busy={false}
                        onSend={onSend}
                        onInterrupt={() => {}}
                        agents={agents}
                        models={models}
                        agent={agent}
                        model={model}
                        onAgentChange={onAgentChange}
                        onModelChange={onModelChange}
                        conversationStarted={false}
                        api={api}
                        catalogOnly={catalogOnly}
                        directory={directory}
                        onDirectoryChange={onDirectoryChange}
                        onOpenModelConfig={onOpenModelConfig}
                    />
                </div>
            </div>
        </div>
    );
}
