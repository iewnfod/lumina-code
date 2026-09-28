/**
 * Minimal STORED-zip reader — the read side of the plan archive. The
 * plugin's buildStoredZip (src/plugins/luminaTools.js) writes strictly
 * uncompressed entries, so reading one back is central-directory parsing
 * plus slicing: no inflate, no deps. Used by the stats panel's document
 * view buttons to show plan.md / report.md from .lumina/archived/ zips
 * after acceptance removed the task directory.
 *
 * Pure: no React, no fetch — node-testable.
 */

/** DataView over a Uint8Array's exact range. */
function view(bytes: Uint8Array, at: number): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset + at, bytes.byteLength - at);
}

/** Read the central directory's start offset and entry count from the
 * End Of Central Directory record (a signature scan from the tail — the
 * zip may be followed by nothing in our writer, but scanning is the
 * robust form). Null when no EOCD is found (not a zip / truncated). */
function locateCentralDirectory(bytes: Uint8Array): {offset: number; count: number} | null {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const min = Math.max(0, bytes.length - 22 - 65536);
    for (let at = bytes.length - 22; at >= min; at--) {
        if (dv.getUint32(at, true) !== 0x06054b50) continue;
        return {offset: dv.getUint32(at + 16, true), count: dv.getUint16(at + 10, true)};
    }
    return null;
}

/**
 * One entry's decompressed text from a stored zip, by exact name —
 * matching how the archive names its members ("plan.md", "report.md",
 * "tasks.md", "history/<file>"). Null when the name is absent or the
 * entry is not stored (our writer never compresses; anything else is a
 * foreign zip we refuse rather than mis-decode).
 */
export function readStoredZipEntry(bytes: Uint8Array, name: string): string | null {
    const cd = locateCentralDirectory(bytes);
    if (!cd) return null;
    const wanted = new TextEncoder().encode(name);
    const cdView = view(bytes, cd.offset);
    let at = 0;
    for (let i = 0; i < cd.count; i++) {
        if (cdView.getUint32(at, true) !== 0x02014b50) return null; // central header lost
        const method = cdView.getUint16(at + 10, true);
        const size = cdView.getUint32(at + 20, true);
        const nameLen = cdView.getUint16(at + 28, true);
        const extraLen = cdView.getUint16(at + 30, true);
        const commentLen = cdView.getUint16(at + 32, true);
        const localOffset = cdView.getUint32(at + 42, true);
        const entryName = bytes.subarray(cd.offset + at + 46, cd.offset + at + 46 + nameLen);
        const matches = entryName.length === wanted.length && wanted.every((b, j) => entryName[j] === b);
        if (matches) {
            if (method !== 0) return null; // compressed — not one of ours
            // The local header repeats the name; the data follows it.
            const lv = view(bytes, localOffset);
            if (lv.getUint32(0, true) !== 0x04034b50) return null;
            const localNameLen = lv.getUint16(26, true);
            const localExtraLen = lv.getUint16(28, true);
            const start = localOffset + 30 + localNameLen + localExtraLen;
            return new TextDecoder().decode(bytes.subarray(start, start + size));
        }
        at += 46 + nameLen + extraLen + commentLen;
    }
    return null;
}
