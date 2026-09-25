import type {ComposerAttachment} from "../../opencode/types.ts";

/**
 * The composer draft store: an in-memory Map keyed by surface — the
 * welcome screen uses the fixed WELCOME_DRAFT_KEY, open sessions use
 * their session id. Keeps half-typed prompts (serialized Lexical
 * EditorState + staged attachments) across the session-surface swap
 * (App's SessionSurface REMOUNTS ChatView/WelcomeScreen per key, so
 * component state alone loses the buffer on every switch).
 *
 * Memory only, deliberately NOT localStorage: attachments are data
 * URIs (images) that can be large, and drafts dying with the app is
 * the desired behavior. Entries are tiny and bounded by the number of
 * surfaces, so no eviction is needed.
 */
export const WELCOME_DRAFT_KEY = "welcome";

interface ComposerDraft {
    editorState: string;
    attachments: ComposerAttachment[];
}

const drafts = new Map<string, ComposerDraft>();

/** Merge the serialized editor state into a surface's draft (attachments
 * preserved). Called on every content change — the state is small. */
export function saveDraftEditorState(key: string, editorState: string): void {
    const prev = drafts.get(key);
    drafts.set(key, {editorState, attachments: prev?.attachments ?? []});
}

/** Merge the staged attachments into a surface's draft (editor state
 * preserved). */
export function saveDraftAttachments(key: string, attachments: ComposerAttachment[]): void {
    const prev = drafts.get(key);
    drafts.set(key, {editorState: prev?.editorState ?? "", attachments});
}

/** The stored draft for a surface, if any. Read at mount time to seed
 * the editor; the entry stays until cleared (a same-surface remount
 * re-reads it) or submitted. */
export function takeInitialDraft(key: string): ComposerDraft | null {
    return drafts.get(key) ?? null;
}

/** Drop the draft after a successful submit. */
export function clearDraft(key: string): void {
    drafts.delete(key);
}
