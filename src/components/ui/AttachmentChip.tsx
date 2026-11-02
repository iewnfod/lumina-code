import {fileIconUrl} from "../../lib/fileIcons.ts";

/** The ONE attachment-chip family (§3.8): h-7, radius-sm, activeOverlay
 *  background — wherever an attachment renders (composer staging,
 *  message bubbles). The caller decides interactivity (button vs span)
 *  and appends its own modifiers; the padding/width core stays uniform
 *  so the family cannot drift again. */
export const ATTACHMENT_CHIP_CLASS =
    "inline-flex items-center gap-1.5 h-7 pl-2 pr-2 rounded-[var(--radius-sm)] max-w-60 transition-colors duration-[var(--duration-fast)]";

/** The chip's leading icon: an image thumbnail when one is available,
 *  else the file-type icon. */
export function AttachmentChipIcon({thumb, name}: {thumb: string | null; name: string}) {
    return thumb !== null ? (
        <img src={thumb} alt="" className="w-5 h-5 rounded-[var(--radius-xs)] object-cover shrink-0"/>
    ) : (
        <img src={fileIconUrl(name)} alt="" className="w-4 h-4 shrink-0"/>
    );
}
