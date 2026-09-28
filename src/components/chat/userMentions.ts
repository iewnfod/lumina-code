import {folderLabel} from "../../lib/path.ts";

/**
 * Pure segmentation of a SENT user prompt into plain text and `@path`
 * file-mention tokens — the user bubble renders the mentions with the
 * same look as the composer's inline token (icon + file name, no `@`;
 * see `.lum-file-mention` and UserMentionText in MessageItem.tsx).
 *
 * The wire text keeps the `@relative` form (the server resolves file
 * mentions from it), so the bubble parses it back lexically — the token
 * must look like a path (contains a `/` or a `.`), the `@` must sit at a
 * word boundary (start/whitespace/punctuation/CJK — mirroring the
 * composer's CJK-aware trigger rule, so "看这个@AGENTS.md" mentions; a
 * word char before the `@` is prose like an email and stays plain), and
 * sentence punctuation (ASCII or CJK) closes the token and stays in the
 * text ("@AGENTS.md。" mentions AGENTS.md).
 */
export type UserMentionSegment =
    | {kind: "text"; text: string}
    | {kind: "mention"; relative: string; name: string};

/** Token body: no whitespace, no further `@`, no sentence punctuation —
 *  ASCII and CJK closers TERMINATE the token (CJK prose follows a
 *  mention without a space, so "，然后" must not be consumed). `.` stays
 *  consumable for extensions; a trailing run of `.`/`/` is trimmed back
 *  into the text by TRAILING_TRIM. */
const TOKEN_RE = /@([^\s@,;:!?()[\]{}<>"'“”‘’…，。；：！？）【】「」『』]+)/g;
const TRAILING_TRIM = /[./]+$/;
/** The token must look like a path to style it as a mention. */
const PATH_SHAPED = /[./]/;

export function splitUserMentions(text: string): UserMentionSegment[] {
    const segments: UserMentionSegment[] = [];
    let cursor = 0;
    TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN_RE.exec(text)) !== null) {
        const at = match.index;
        const before = at === 0 ? "" : text[at - 1];
        // Word characters (and another @) before the trigger read as
        // prose (handles, emails) — not a mention boundary.
        if (/[A-Za-z0-9_@]/.test(before)) continue;
        const relative = match[1].replace(TRAILING_TRIM, "");
        if (!PATH_SHAPED.test(relative)) continue;
        const end = at + 1 + relative.length;
        if (cursor < at) segments.push({kind: "text", text: text.slice(cursor, at)});
        segments.push({kind: "mention", relative, name: folderLabel(relative)});
        cursor = end;
    }
    if (cursor < text.length) segments.push({kind: "text", text: text.slice(cursor)});
    return segments;
}
