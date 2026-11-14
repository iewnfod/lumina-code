import {createContext, useContext, useMemo, type ReactNode} from "react";
import type {SessionModelRef, SessionUsage} from "../../opencode/types.ts";

/**
 * The composer's SELECTION channel — the agent/model/directory/branch
 * picks + usage reference the composer toolbar renders, provided ONCE by
 * App (the values are App-level state: session-bound once a session
 * exists, the welcome screen's staged picks otherwise) and read by every
 * consumer that used to thread them as props:
 * App → ChatView → ChatInput → ComposerToolbar (14→24→19 props of pure
 * pass-through before this context existed).
 *
 * Value identity matters: ChatInput is memoized and its subtree skips
 * re-renders while tokens stream, so the provider's value object is
 * useMemo'd in App — a fresh object per render would defeat that memo
 * as thoroughly as inline callbacks would.
 */
export interface ComposerSelection {
    /** Effective agent ("mode") selection. */
    agent: string;
    model: SessionModelRef | null;
    onAgentChange: (agent: string) => void;
    onModelChange: (model: SessionModelRef) => void;
    /** The composer's working directory (null = server default) — the
     *  ACTIVE session's once a session exists, the staged pick on the
     *  welcome screen. */
    directory: string | null;
    onDirectoryChange: (directory: string | null) => void;
    /** Staged branch binding — only meaningful before the first message
     *  (the picker is pre-session). */
    stagedBranch: string | null;
    onStagedBranchChange: (branch: string | null) => void;
    /** Opens the settings on its Model tab (model/provider config). */
    onOpenModelConfig: () => void;
    /** The session's cumulative usage — tooltip reference lines for the
     *  composer's context ring; null on the welcome screen. */
    usage: SessionUsage | null;
}

const SelectionContext = createContext<ComposerSelection | null>(null);

export function ComposerSelectionProvider({value, children}: {
    value: ComposerSelection;
    children: ReactNode;
}) {
    return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** The composer selection channel. Throws when mounted outside the
 *  provider — every consumer lives inside App's chrome, so a missing
 *  provider is a wiring bug worth crashing on. */
export function useComposerSelection(): ComposerSelection {
    const value = useContext(SelectionContext);
    if (value === null) throw new Error("useComposerSelection requires ComposerSelectionProvider");
    return value;
}

/** Convenience: build the provider value memoized from the parts (the
 *  object identity discipline lives here, not in every provider site). */
export function useComposerSelectionValue(parts: ComposerSelection): ComposerSelection {
    return useMemo(() => parts, [parts.agent, parts.model, parts.onAgentChange, parts.onModelChange,
        parts.directory, parts.onDirectoryChange, parts.stagedBranch, parts.onStagedBranchChange,
        parts.onOpenModelConfig, parts.usage]);
}
