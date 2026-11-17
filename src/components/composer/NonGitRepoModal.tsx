import {useState} from "react";
import {AlertTriangle} from "lucide-react";
import Modal from "../ui/Modal.tsx";
import Button from "../ui/Button.tsx";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {initGitRepo} from "../../opencode/gitRepo.ts";

/**
 * The dev-mode NON-REPO confirmation: the user just picked a directory
 * that is not inside a git work tree (DirectoryPicker's probe), and
 * dev's git-flavored features — branch pickers, worktrees, per-turn
 * edit summaries, the workspace change stats — degrade silently on a
 * plain folder. Two ways out, per the picker's design:
 *
 * - 创建仓库: `git init` right there (opencode/gitRepo.ts — bare init,
 *   the user's default-branch config decides the name). Success
 *   applies the selection; failure keeps the modal open with git's own
 *   error text so the user can retry or fall back to ignoring.
 * - 无视风险并继续: apply the selection untouched.
 *
 * Closing (X / Escape / backdrop / mobile back) CANCELS — the staged
 * directory stays what it was; the picked folder is abandoned.
 */
export default function NonGitRepoModal({
    directory,
    onCancel,
    onConfirm,
}: {
    /** The directory awaiting the decision (shown verbatim so the user
     * knows exactly what would be initialized). */
    directory: string;
    /** Abandon the selection (X / Esc / backdrop). */
    onCancel: () => void;
    /** Apply the selection — after a successful init OR an explicit
     * ignore. `initialized` tells the caller which way it went (only
     * for logging/telemetry shape; behavior is the same). */
    onConfirm: (initialized: boolean) => void;
}) {
    const t = useI18n();
    const colors = useColors();
    const {api} = useConnection();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const create = async () => {
        if (!api || busy) return;
        setBusy(true);
        setError(null);
        const result = await initGitRepo(api, directory);
        setBusy(false);
        if (result.ok) {
            onConfirm(true);
            return;
        }
        // Stay open: git's own output is the error text, and both
        // buttons remain — retry, or ignore the risk and continue.
        setError(result.message ?? t["Failed to create repository"]);
    };

    return (
        <Modal
            open
            onClose={onCancel}
            width={480}
            title={
                // The warning mark leads the TITLE (the panel's top-left
                // corner) — the header row, next to the label.
                <span className="inline-flex items-center gap-1.5">
                    <AlertTriangle size={14} className="shrink-0" style={{color: "var(--color-warning)"}}/>
                    {t["Not a Git Repository"]}
                </span>
            }
        >
            <div className="flex flex-col gap-3 px-4 py-4">
                <div className="flex flex-col gap-2">
                    <span className="text-sm leading-relaxed" style={{color: colors.textPrimary}}>
                        {t["This directory is not inside a Git repository. Git-dependent features (branch picking, change stats, per-turn edit summaries) may not work."]}
                    </span>
                    <code
                        className="block w-full px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs break-all"
                        style={{
                            background: colors.recessedBg,
                            border: `1px solid ${colors.glassBorder}`,
                            color: colors.textPrimary,
                        }}
                    >
                        {directory}
                    </code>
                </div>
                {error != null && (
                    <div
                        className="px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs whitespace-pre-wrap break-all"
                        style={{background: colors.recessedBg, color: "var(--color-danger-text)"}}
                    >
                        {error}
                    </div>
                )}
                <div className="flex justify-end gap-2 pt-1">
                    <Button label={t["Ignore Risk and Continue"]} disabled={busy} onClick={() => onConfirm(false)} />
                    <Button
                        label={busy ? t["Creating repository..."] : t["Create Repository"]}
                        primary
                        disabled={busy || !api}
                        onClick={() => void create()}
                    />
                </div>
            </div>
        </Modal>
    );
}
