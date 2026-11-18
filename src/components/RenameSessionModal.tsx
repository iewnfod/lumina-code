import {useState, type FormEvent} from "react";
import Modal from "./ui/Modal.tsx";
import Button from "./ui/Button.tsx";
import {useColors} from "../hooks/colors.tsx";
import {useI18n} from "../hooks/i18n.tsx";
import type {OpencodeSession} from "../opencode/types.ts";

/** The session-rename dialog behind the title bar's ⋯ menu: one text
 *  field prefilled with the session's current title, Enter or 保存
 *  submits, and a failed PATCH keeps the dialog OPEN with the error so
 *  the user can retry (the session list re-lists to the server's
 *  authoritative title in the meantime — see useSessions.rename).
 *  Closing (X / Esc / backdrop / mobile back) cancels: nothing is sent.
 *  Built on the NonGitRepoModal chrome pattern. */
export default function RenameSessionModal({
    session,
    onClose,
    onRename,
}: {
    /** The session being renamed (its current title prefills the field). */
    session: OpencodeSession;
    /** Rename to the trimmed title; resolves whether the server took
     *  it — only a `true` closes the dialog. */
    onRename: (title: string) => Promise<boolean>;
    /** Abandon the rename (X / Esc / backdrop). */
    onClose: () => void;
}) {
    const t = useI18n();
    const colors = useColors();
    const [title, setTitle] = useState(session.title ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const trimmed = title.trim();
    const submittable = !busy && trimmed.length > 0 && trimmed !== (session.title ?? "");

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!submittable) return;
        setBusy(true);
        setError(null);
        const ok = await onRename(trimmed);
        setBusy(false);
        if (ok) onClose();
        else setError(t["Rename failed"]);
    };

    return (
        <Modal open onClose={onClose} width={440} title={t["Rename session"]}>
            <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 px-4 py-4">
                <input
                    // autoFocus + focus-select: the prefilled name is a
                    // starting point, not a default — the common rename
                    // replaces it wholesale.
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                    spellCheck={false}
                    disabled={busy}
                    className="w-full px-2.5 py-1.5 rounded-[var(--radius-sm)] text-sm outline-none"
                    style={{
                        background: colors.recessedBg,
                        border: `1px solid ${colors.glassBorder}`,
                        color: colors.textPrimary,
                    }}
                />
                {error != null && (
                    <div
                        className="px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs whitespace-pre-wrap break-all"
                        style={{background: colors.recessedBg, color: "var(--color-danger-text)"}}
                    >
                        {error}
                    </div>
                )}
                <div className="flex justify-end gap-2 pt-1">
                    <Button label={t["Cancel"]} disabled={busy} onClick={onClose}/>
                    <Button label={t["Save"]} primary type="submit" disabled={!submittable}/>
                </div>
            </form>
        </Modal>
    );
}
