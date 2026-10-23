// Lumina Code Office Tools — the Word/PPT plugin shipped with the app.
//
// Distribution: Lumina Code writes this file to
// `<global config>/plugins/office-tools/index.js` together with the two
// vendored document engines under `vendor/` (see
// src/plugins/officeToolsVendor/ + scripts/build-plugin-vendor.mjs), and
// references the directory from the global opencode.json's `plugins`
// array. A SEPARATE plugin from lumina-tools on purpose: that one is the
// OpenCode system-enhancement layer (plan workflow, system prompt, host
// identity); this one is a domain capability (office documents).
//
// Adding a tool: same TOOLS-registry shape as lumina-tools
// ({enabled, tool(options, ctx)}); tool descriptions are written for the
// CALLING model — they are the model's only manual.
//
// v2.0.11 facts this file relies on (spike-verified 2026-10-23 unless
// noted):
//   - the Bun-compiled server loads this plugin from disk and DYNAMIC
//     RELATIVE imports (`await import("./vendor/docx.mjs")`) resolve
//     against the INSTALLED plugin directory — verified live by
//     generating a real docx/pptx (incl. CJK) from inside a plugin
//     setup() on the bundled sidecar binary; the server's file watcher
//     even tracks the imported vendor files,
//   - the vendor bundles are esbuild ESM (format esm, platform node —
//     `node:*` builtins stay external): npm `docx` writes .docx via
//     Packer.toBuffer, npm `pptxgenjs` (v4) via write({outputType:
//     "nodebuffer"}); its 16:9 layout key is "LAYOUT_16x9",
//   - dynamic `await import("node:fs"/"node:path"/"node:zlib")` works
//     inside executors (the lumina-tools precedent, live-verified there),
//   - executors receive context.{sessionID, agent, signal}; the
//     session's own directory comes from
//     ctx.session.get({sessionID}).location.directory (NEVER
//     ctx.location — the lumina-tools lesson, live-verified there),
//   - plugin tools default to CODE MODE exposure; `codemode: false`
//     registers them as NATIVE tools the model calls directly (the
//     reliable path — the lumina-tools lesson).
//
// SIDEcar contract (the frontend's preview reads it — keep in sync with
// src/opencode/docstruct.ts): write_document mirrors every generated
// document as <workspace>/.lumina/docstruct/<fileName>.json holding
// {version, source: "office-tools", file, format, size, generatedAt,
// blocks | slides} — `size` is the written file's byte count (the
// preview's staleness signal); blocks/slides are the SAME protocol
// arrays the model passed, so read_document's sidecar path and the
// preview render one shared shape.

// ---------------------------------------------------------------------------
// Node APIs (dynamic imports only — no top-level static imports)
// ---------------------------------------------------------------------------

let NODE_APIS = null;
async function nodeApis() {
  if (!NODE_APIS) {
    NODE_APIS = {fs: await import("node:fs"), path: await import("node:path"), zlib: await import("node:zlib")};
  }
  return NODE_APIS;
}

// ---------------------------------------------------------------------------
// Protocol validation (pure, node-testable)
// ---------------------------------------------------------------------------

/** The office file formats this plugin understands. */
export const FORMATS = ["docx", "pptx"];

/** Path resolution result shared by every entry point. */
function pathError(message) {
  return {error: message};
}

/** Resolve a model-supplied document path against the session directory:
 * absolute paths pass through, relative ones join. `opts.confine`
 * (default true) additionally REJECTS anything resolving outside the
 * directory — writes stay inside the workspace; reads pass {confine:
 * false} so the user can point the AI at a document anywhere on disk.
 * The file name must carry a .docx/.pptx extension (the extension IS
 * the format — a bare name would produce a file Word cannot open).
 * Returns {abs, format, fileName} or {error}. Pure — takes the path
 * module as an argument so node tests inject it. */
export function resolveDocumentPath(p, directory, path, opts) {
  const raw = typeof p === "string" ? p.trim() : "";
  if (!raw) return pathError("'path' is required");
  if (raw.includes("\0")) return pathError("'path' contains a NUL character");
  const abs = path.isAbsolute(raw) ? raw : path.join(directory, raw);
  const normalized = path.normalize(abs);
  if (opts?.confine !== false) {
    // Case-insensitive containment (Windows drive letters/casing); both
    // directions normalized so a trailing separator never fakes a prefix.
    const lower = (s) => s.toLowerCase();
    if (lower(normalized) !== lower(path.normalize(directory)) &&
        !lower(normalized).startsWith(lower(path.normalize(directory)) + path.sep)) {
      return pathError("'path' escapes the working directory");
    }
  }
  const fileName = path.basename(normalized);
  const ext = fileName.toLowerCase().split(".").pop();
  if (!FORMATS.includes(ext) || path.extname(fileName).toLowerCase() !== `.${ext}`) {
    return pathError("the path must end in .docx or .pptx — the extension decides the format");
  }
  return {abs: normalized, format: ext, fileName};
}

/** String with visible content after trimming. */
function meaningfulString(v) {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/** Validate docx blocks: [{type: heading|paragraph|list|table|image, …}].
 * Returns {blocks} normalized (strings trimmed, unknown fields dropped)
 * or {error} naming the first problem — errors are protocol feedback for
 * the calling model. Pure. */
export function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return pathError("'blocks' must be a non-empty array");
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] ?? {};
    const at = `blocks[${i}]`;
    switch (b.type) {
      case "heading": {
        const text = meaningfulString(b.text);
        const level = b.level === 1 || b.level === 2 || b.level === 3 ? b.level : null;
        if (!text) return pathError(`${at}: 'text' is required`);
        if (!level) return pathError(`${at}: 'level' must be 1, 2 or 3`);
        out.push({type: "heading", level, text: text.trim()});
        break;
      }
      case "paragraph": {
        const text = meaningfulString(b.text);
        if (!text) return pathError(`${at}: 'text' is required`);
        const paragraph = {type: "paragraph", text: text.trim()};
        if (b.bold === true) paragraph.bold = true;
        if (b.italic === true) paragraph.italic = true;
        out.push(paragraph);
        break;
      }
      case "list": {
        if (!Array.isArray(b.items) || b.items.length === 0) {
          return pathError(`${at}: 'items' must be a non-empty array of strings`);
        }
        // STRICT: one blank item rejects the whole call — the model should
        // send clean data, and silent filtering would hide protocol drift.
        const items = [];
        for (const item of b.items) {
          const text = meaningfulString(item);
          if (!text) return pathError(`${at}: 'items' must not contain blank strings`);
          items.push(text.trim());
        }
        out.push({type: "list", ordered: b.ordered === true, items});
        break;
      }
      case "table": {
        const rows = Array.isArray(b.rows)
          ? b.rows.map((row) =>
              Array.isArray(row) ? row.map((c) => (typeof c === "string" ? c.trim() : String(c ?? ""))) : null)
          : null;
        if (!rows || rows.some((r) => r === null)) return pathError(`${at}: 'rows' must be an array of string arrays`);
        if (rows.length === 0) return pathError(`${at}: 'rows' must not be empty`);
        if (rows.some((r) => r.length !== rows[0].length)) {
          return pathError(`${at}: every row needs the same number of cells`);
        }
        const table = {type: "table", rows};
        const header = Array.isArray(b.header)
          ? b.header.map((c) => (typeof c === "string" ? c.trim() : String(c ?? "")))
          : null;
        if (header) {
          if (header.length !== rows[0].length) {
            return pathError(`${at}: 'header' length must match the row width`);
          }
          table.header = header;
        }
        out.push(table);
        break;
      }
      case "image": {
        const imgPath = meaningfulString(b.path);
        if (!imgPath) return pathError(`${at}: 'path' (workspace image file) is required`);
        const image = {type: "image", path: imgPath.trim()};
        const caption = meaningfulString(b.caption);
        if (caption) image.caption = caption.trim();
        out.push(image);
        break;
      }
      default:
        return pathError(`${at}: unknown type "${String(b.type)}" — heading | paragraph | list | table | image`);
    }
  }
  return {blocks: out};
}

const SLIDE_LAYOUTS = ["title", "titleContent", "twoContent", "blank"];

/** Validate pptx slides: [{layout, title?, subtitle?, bullets?, image?,
 * notes?}]. Same contract as validateBlocks. Pure. */
export function validateSlides(slides) {
  if (!Array.isArray(slides) || slides.length === 0) return pathError("'slides' must be a non-empty array");
  const out = [];
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i] ?? {};
    const at = `slides[${i}]`;
    const layout = SLIDE_LAYOUTS.includes(s.layout) ? s.layout : null;
    if (!layout) return pathError(`${at}: 'layout' must be one of: ${SLIDE_LAYOUTS.join(", ")}`);
    const slide = {layout};
    const title = meaningfulString(s.title);
    if (title) slide.title = title.trim();
    const subtitle = meaningfulString(s.subtitle);
    if (subtitle) slide.subtitle = subtitle.trim();
    if (Array.isArray(s.bullets)) {
      const bullets = [];
      for (const item of s.bullets) {
        const text = meaningfulString(item?.text ?? item);
        if (!text) return pathError(`${at}.bullets: every bullet needs non-empty 'text'`);
        const level = item?.level === 1 ? 1 : 0;
        bullets.push({text: text.trim(), level});
      }
      if (bullets.length > 0) slide.bullets = bullets;
    }
    const image = meaningfulString(s.image);
    if (image) slide.image = image.trim();
    const notes = meaningfulString(s.notes);
    if (notes) slide.notes = notes.trim();
    if (!slide.title && !slide.subtitle && !slide.bullets && !slide.image) {
      return pathError(`${at}: a slide needs at least one of title/subtitle/bullets/image`);
    }
    out.push(slide);
  }
  return {slides: out};
}

// ---------------------------------------------------------------------------
// Sidecar composition (pure, node-testable) — the frontend contract
// ---------------------------------------------------------------------------

/** Sidecar file name for a document: `<fileName>.json` (the full name
 * including the extension, so 报告.docx and 报告.pptx never collide). */
export function sidecarName(fileName) {
  return `${fileName}.json`;
}

/** Compose the sidecar JSON text for a written document. `payload` is
 * {blocks} for docx, {slides} for pptx. Pure. */
export function composeDocstruct(fileName, format, size, payload, now = new Date()) {
  return JSON.stringify(
    {
      version: 1,
      source: "office-tools",
      file: fileName,
      format,
      size,
      generatedAt: now.toISOString(),
      ...payload,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Blocks → markdown (pure) — read_document's sidecar path and the
// protocol's canonical preview shape share this rendering
// ---------------------------------------------------------------------------

function mdEscapeCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Render validated docx blocks as markdown. Pure. */
export function blocksToMarkdown(blocks) {
  const lines = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading":
        lines.push(`${"#".repeat(b.level)} ${b.text}`, "");
        break;
      case "paragraph":
        lines.push(b.text, "");
        break;
      case "list": {
        const bullet = b.ordered ? (n) => `${n}. ` : () => "- ";
        b.items.forEach((item, i) => lines.push(bullet(i + 1) + item));
        lines.push("");
        break;
      }
      case "table": {
        const width = b.rows[0].length;
        const header = b.header ?? b.rows[0];
        lines.push(`| ${header.map(mdEscapeCell).join(" | ")} |`);
        lines.push(`| ${Array(width).fill("---").join(" | ")} |`);
        for (const row of b.header ? b.rows : b.rows.slice(1)) {
          lines.push(`| ${row.map(mdEscapeCell).join(" | ")} |`);
        }
        lines.push("");
        break;
      }
      case "image":
        lines.push(`![${b.caption ?? b.path.split("/").pop()}](${b.path})`, "");
        break;
    }
  }
  return lines.join("\n").trim() + "\n";
}

/** Render validated pptx slides as markdown (one section per slide).
 * Pure. */
export function slidesToMarkdown(slides) {
  const lines = [];
  slides.forEach((s, i) => {
    lines.push(`## Slide ${i + 1}${s.title ? ` — ${s.title}` : ""}`, "");
    if (s.subtitle) lines.push(s.subtitle, "");
    for (const b of s.bullets ?? []) lines.push(`${"  ".repeat(b.level)}- ${b.text}`);
    if (s.bullets) lines.push("");
    if (s.image) lines.push(`![image](${s.image})`, "");
    if (s.notes) lines.push(`> notes: ${s.notes}`, "");
  });
  return lines.join("\n").trim() + "\n";
}

// ---------------------------------------------------------------------------
// Image dimension sniffing (pure) — PNG/JPEG headers only; everything
// else falls back to a default box
// ---------------------------------------------------------------------------

/** Default image box (px) when the format cannot be sniffed. */
export const DEFAULT_IMAGE = {width: 480, height: 320};

/** Max rendered width (px) — an A4 content area at 96dpi is ~624px. */
export const MAX_IMAGE_WIDTH = 560;

/** Sniff {kind: "png"|"jpeg", width, height} (px) out of an image
 * header — kind comes from the CONTENT, never the file name (a .png
 * extension on JPEG bytes must not poison the embedded type). Pure. */
export function imageDimensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24) return null;
  // PNG: 8-byte signature then IHDR (width @16, height @20, big-endian).
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return {
      kind: "png",
      width: (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19],
      height: (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23],
    };
  }
  // JPEG: walk segment markers to the first SOF frame.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at++;
        continue;
      }
      const marker = bytes[at + 1];
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          kind: "jpeg",
          height: (bytes[at + 5] << 8) | bytes[at + 6],
          width: (bytes[at + 7] << 8) | bytes[at + 8],
        };
      }
      const size = (bytes[at + 2] << 8) | bytes[at + 3];
      if (size <= 0) return null;
      at += 2 + size;
    }
  }
  return null;
}

/** Image box for rendering: sniffed (width-capped, aspect-kept) or the
 * default. Pure. */
export function imageBox(bytes) {
  const sniffed = imageDimensions(bytes);
  if (!sniffed || !sniffed.width || !sniffed.height) return {...DEFAULT_IMAGE};
  if (sniffed.width <= MAX_IMAGE_WIDTH) return sniffed;
  return {
    width: MAX_IMAGE_WIDTH,
    height: Math.max(1, Math.round((sniffed.height / sniffed.width) * MAX_IMAGE_WIDTH)),
  };
}

// ---------------------------------------------------------------------------
// Zip reading (pure + zlib, node-testable) — the read side of OOXML
// ---------------------------------------------------------------------------

/** Read a zip archive into Map<name, Uint8Array>. Supports STORED and
 * DEFLATE entries (everything Word/PowerPoint write). Throws on
 * malformed input — callers translate to a degraded read. */
export async function readZipEntries(bytes) {
  const {zlib} = await nodeApis();
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) throw new Error("not a zip archive (too short)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Locate the End Of Central Directory record: scan back over a possible
  // archive comment (max 65535 bytes).
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 22 - 65535);
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip EOCD signature not found");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(`zip central directory broken at entry ${i}`);
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    // The local header carries its OWN name/extra lengths — they can
    // differ from the central record's, so re-read them there.
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`zip local header broken for ${name}`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      out.set(name, new Uint8Array(raw));
    } else if (method === 8) {
      out.set(name, new Uint8Array(zlib.inflateRawSync(raw)));
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OOXML text extraction (pure) — read_document's legacy-document path
// ---------------------------------------------------------------------------

const XML_ENTITIES = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, "\""],
  [/&apos;/g, "'"],
  [/&amp;/g, "&"], // last: avoids double-decoding the others
];

function decodeXmlEntities(s) {
  let out = s;
  for (const [re, replacement] of XML_ENTITIES) out = out.replace(re, replacement);
  return out;
}

/** Concatenate every <w:t>/<a:t> run's text inside one XML fragment. */
function runText(xml, tag) {
  let out = "";
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g");
  for (const m of xml.matchAll(re)) out += decodeXmlEntities(m[1]);
  return out;
}

/** Split a docx body into ordered top-level paragraph/table fragments
 * (tables may nest; nested tables' text still rides the outer fragment).
 * Pure — an unparseable body yields [] and the caller degrades to raw
 * text extraction. */
export function splitDocxBody(xml) {
  const items = [];
  const tokenRe = /<(\/?)w:(p|tbl)(?:\s[^>]*)?>/g;
  let tblDepth = 0;
  let tblStart = -1;
  for (const m of xml.matchAll(tokenRe)) {
    const closing = m[1] === "/";
    const isTable = m[2] === "tbl";
    if (!closing && isTable) {
      if (tblDepth === 0) tblStart = m.index;
      tblDepth++;
    } else if (closing && isTable) {
      tblDepth = Math.max(0, tblDepth - 1);
      if (tblDepth === 0 && tblStart >= 0) {
        items.push({kind: "tbl", xml: xml.slice(tblStart, m.index + m[0].length)});
        tblStart = -1;
      }
    } else if (!closing && tblDepth === 0) {
      // Top-level paragraph — span to its close. No lastIndex skipping
      // needed: a w:p contains no nested w:p/w:tbl tokens, and the
      // closing </w:p> token simply falls through the branches above.
      const closeAt = xml.indexOf("</w:p>", m.index);
      if (closeAt < 0) break;
      items.push({kind: "p", xml: xml.slice(m.index, closeAt + 6)});
    }
  }
  return items;
}

/** One docx paragraph → markdown line(s); null when it carries no text. */
function docxParagraphLines(pXml) {
  const text = runText(pXml, "w:t").trim();
  if (!text) return null;
  const style = /<w:pStyle w:val="([^"]*)"/.exec(pXml)?.[1]?.toLowerCase() ?? "";
  const isListItem = pXml.includes("<w:numPr>");
  if (style === "title" || style === "heading1") return [`# ${text}`];
  if (style === "heading2") return [`## ${text}`];
  if (style.startsWith("heading")) return [`### ${text}`]; // 3..9 all collapse to 3
  if (isListItem) return [`- ${text}`]; // ordered/unordered is unresolvable without numbering.xml — kept flat
  return [text];
}

/** One docx table fragment → markdown table lines. */
function docxTableLines(tXml) {
  const rows = [];
  for (const row of tXml.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)) {
    const cells = [];
    for (const cell of row[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)) {
      cells.push(mdEscapeCell(runText(cell[0], "w:t").trim()));
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return null;
  const width = rows[0].length;
  const lines = [`| ${rows[0].join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`];
  for (const row of rows.slice(1)) lines.push(`| ${row.join(" | ")} |`);
  return lines;
}

/** Extract a docx zip's readable content as markdown. `degraded` flags
 * the raw-text fallback (structure unreadable). Pure over the entries. */
export function docxToMarkdown(entries) {
  const decoder = new TextDecoder();
  const doc = entries.get("word/document.xml");
  if (!doc) return {markdown: "", degraded: true};
  const xml = decoder.decode(doc);
  const lines = [];
  let structured = false;
  for (const item of splitDocxBody(xml)) {
    if (item.kind === "tbl") {
      const table = docxTableLines(item.xml);
      if (table) {
        lines.push(...table, "");
        structured = true;
      }
      continue;
    }
    const paragraph = docxParagraphLines(item.xml);
    if (paragraph) {
      lines.push(...paragraph, "");
      structured = true;
    }
  }
  if (!structured) {
    // Degraded: hand the model every text run in document order.
    const text = runText(xml, "w:t").trim();
    return {markdown: text ? `${text}\n` : "", degraded: true};
  }
  return {markdown: lines.join("\n").trim() + "\n", degraded: false};
}

/** Extract a pptx zip's readable content as markdown (slides in numeric
 * order, speaker notes appended per slide). Pure over the entries. */
export function pptxToMarkdown(entries) {
  const decoder = new TextDecoder();
  const slideNames = [...entries.keys()]
    .filter((n) => /^ppt\/slides\/slide(\d+)\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  if (slideNames.length === 0) return {markdown: "", degraded: true};
  const lines = [];
  slideNames.forEach((name, i) => {
    const xml = decoder.decode(entries.get(name));
    const slideLines = [];
    // Each <a:p> is one paragraph; its <a:t> runs concatenate.
    for (const p of xml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)) {
      const text = runText(p[0], "a:t").trim();
      if (text) slideLines.push(text);
    }
    lines.push(`## Slide ${i + 1}`, "");
    if (slideLines.length > 0) {
      lines.push(...slideLines, "");
    }
    const num = /(\d+)\.xml$/.exec(name)[1];
    const notes = entries.get(`ppt/notesSlides/notesSlide${num}.xml`);
    if (notes) {
      const notesText = runText(decoder.decode(notes), "a:t").replace(/\s+/g, " ").trim();
      // Strip the ubiquitous slide-number placeholder page number.
      const cleaned = notesText.replace(/\s*\d+\s*$/, "").trim();
      if (cleaned) lines.push(`> notes: ${cleaned}`, "");
    }
  });
  return {markdown: lines.join("\n").trim() + "\n", degraded: slideNames.length === 0};
}

// ---------------------------------------------------------------------------
// Engine loading (the spike-verified relative vendor import)
// ---------------------------------------------------------------------------

/** Load the vendored document engines from the installed plugin's
 * `vendor/` directory. Verified live (2026-10-23): the Bun-compiled
 * server resolves the RELATIVE specifier against this file's location,
 * so the bundles ride along with the plugin's own installation. Returns
 * null when they are unavailable (write_document then stays
 * unregistered — read_document needs no engine and always registers). */
async function loadEngines() {
  try {
    const docx = (await import("./vendor/docx.mjs")).default;
    const pptxMod = await import("./vendor/pptxgenjs.mjs");
    const PptxGenJS = pptxMod.default && pptxMod.default.default ? pptxMod.default.default : pptxMod.default;
    if (typeof docx?.Document !== "function" || typeof PptxGenJS !== "function") return null;
    return {docx, PptxGenJS};
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Document builders (engine-bound; node tests drive them through the
// SAME vendor bundles the server loads)
// ---------------------------------------------------------------------------

/** CJK-friendly default run font: Calibri for latin, Microsoft YaHei for
 * east-asian glyphs (Word and WPS both ship it; other systems
 * substitute). */
const DOC_FONTS = {ascii: "Calibri", eastAsia: "Microsoft YaHei", hAnsi: "Calibri"};

/** Build a .docx from validated blocks → Uint8Array. Throws on engine
 * errors (the executor surfaces the message). */
export async function buildDocxBytes(engines, blocks) {
  const {docx} = engines;
  const numbering = {config: [{reference: "lumina-ordered", levels: [
    {level: 0, format: "decimal", text: "%1.", alignment: docx.AlignmentType?.START ?? "start"},
  ]}]};
  const children = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading":
        children.push(new docx.Paragraph({
          text: b.text,
          heading: [docx.HeadingLevel.HEADING_1, docx.HeadingLevel.HEADING_2, docx.HeadingLevel.HEADING_3][b.level - 1],
        }));
        break;
      case "paragraph":
        children.push(new docx.Paragraph({
          children: [new docx.TextRun({text: b.text, bold: b.bold === true, italic: b.italic === true})],
        }));
        break;
      case "list":
        for (const item of b.items) {
          children.push(new docx.Paragraph(
            b.ordered
              ? {text: item, numbering: {reference: "lumina-ordered", level: 0}}
              : {text: item, bullet: {level: 0}},
          ));
        }
        break;
      case "table": {
        const tableRows = [];
        if (b.header) {
          tableRows.push(new docx.TableRow({
            children: b.header.map((cell) => new docx.TableCell({
              children: [new docx.Paragraph({children: [new docx.TextRun({text: cell, bold: true})]})],
            })),
          }));
        }
        for (const row of b.rows) {
          tableRows.push(new docx.TableRow({
            children: row.map((cell) => new docx.TableCell({
              children: [new docx.Paragraph(cell)],
            })),
          }));
        }
        children.push(new docx.Table({rows: tableRows, width: {size: 100, type: docx.WidthType?.PERCENTAGE ?? "pct"}}));
        break;
      }
      case "image": {
        // The executor pre-loads image bytes into b._bytes/_imageKind —
        // validated blocks never carry them (the wire protocol stays
        // JSON-clean); the builder reads them defensively.
        const bytes = b._bytes;
        if (!(bytes instanceof Uint8Array)) {
          throw new Error(`image not loaded: ${b.path}`);
        }
        const box = imageBox(bytes);
        children.push(new docx.Paragraph({
          children: [new docx.ImageRun({
            type: b._imageKind === "jpeg" ? "jpg" : "png", // sniffed kind, not the file name
            data: bytes,
            transformation: box,
          })],
        }));
        if (b.caption) {
          children.push(new docx.Paragraph({
            children: [new docx.TextRun({text: b.caption, italics: true, size: 18})],
            alignment: docx.AlignmentType?.CENTER,
          }));
        }
        break;
      }
    }
  }
  const doc = new docx.Document({
    numbering,
    styles: {
      default: {
        document: {
          run: {font: DOC_FONTS, size: 22}, // 11pt body
        },
      },
    },
    sections: [{children}],
  });
  return new Uint8Array(await docx.Packer.toBuffer(doc));
}

// pptx 16:9 canvas in inches (LAYOUT_16x9 = 10 × 5.625).
const PPTX_W = 10;
const PPTX_H = 5.625;

/** Build a .pptx from validated slides → Uint8Array. Image slides carry
 * pre-loaded bytes on s._bytes like the docx builder. */
export async function buildPptxBytes(engines, slides) {
  const pptx = new engines.PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.theme = {headFontFace: "Microsoft YaHei", bodyFontFace: "Microsoft YaHei"};
  for (const s of slides) {
    const slide = pptx.addSlide();
    const bullets = s.bullets ?? [];
    if (s.layout === "title") {
      if (s.title) slide.addText(s.title, {x: 0.5, y: 2.0, w: PPTX_W - 1, h: 1.0, fontSize: 40, bold: true, align: "center"});
      if (s.subtitle) slide.addText(s.subtitle, {x: 0.5, y: 3.1, w: PPTX_W - 1, h: 0.8, fontSize: 20, align: "center"});
      if (bullets.length > 0) slide.addText(bullets.map((b) => ({text: b.text, options: {bullet: {indent: 12}, indentLevel: b.level}})), {x: 0.8, y: 3.9, w: PPTX_W - 1.6, h: 1.3, fontSize: 14});
    } else if (s.layout === "twoContent") {
      if (s.title) slide.addText(s.title, {x: 0.5, y: 0.4, w: PPTX_W - 1, h: 0.8, fontSize: 28, bold: true});
      const hasImage = s._bytes instanceof Uint8Array;
      const textW = hasImage ? (PPTX_W - 1.6) / 2 : PPTX_W - 1.6;
      if (bullets.length > 0 || s.subtitle) {
        const body = [];
        if (s.subtitle) body.push({text: s.subtitle, options: {fontSize: 16, breakLine: true}});
        for (const b of bullets) body.push({text: b.text, options: {bullet: {indent: 12}, indentLevel: b.level}});
        slide.addText(body, {x: 0.8, y: 1.5, w: textW, h: PPTX_H - 2.0, fontSize: 18, valign: "top"});
      }
      if (hasImage) {
        slide.addImage({data: imageDataUri(s), x: 0.8 + textW + 0.3, y: 1.5, w: textW, h: PPTX_H - 2.0, sizing: {type: "contain", w: textW, h: PPTX_H - 2.0}});
      }
    } else if (s.layout === "blank") {
      if (bullets.length > 0) {
        slide.addText(bullets.map((b) => ({text: b.text, options: {bullet: {indent: 12}, indentLevel: b.level}})), {x: 0.8, y: 0.6, w: PPTX_W - 1.6, h: PPTX_H - 1.2, fontSize: 18, valign: "top"});
      } else if (s._bytes instanceof Uint8Array) {
        slide.addImage({data: imageDataUri(s), x: 0.6, y: 0.5, w: PPTX_W - 1.2, h: PPTX_H - 1.0, sizing: {type: "contain", w: PPTX_W - 1.2, h: PPTX_H - 1.0}});
      }
      if (s.title) slide.addText(s.title, {x: 0.5, y: 0.2, w: PPTX_W - 1, h: 0.5, fontSize: 14});
    } else {
      // titleContent — the workhorse.
      if (s.title) slide.addText(s.title, {x: 0.5, y: 0.4, w: PPTX_W - 1, h: 0.8, fontSize: 28, bold: true});
      let bodyY = 1.5;
      if (s.subtitle) {
        slide.addText(s.subtitle, {x: 0.8, y: 1.4, w: PPTX_W - 1.6, h: 0.5, fontSize: 16});
        bodyY = 2.0;
      }
      if (bullets.length > 0) {
        slide.addText(bullets.map((b) => ({text: b.text, options: {bullet: {indent: 12}, indentLevel: b.level}})), {x: 0.8, y: bodyY, w: PPTX_W - 1.6, h: PPTX_H - bodyY - 0.5, fontSize: 18, valign: "top"});
      }
      if (s._bytes instanceof Uint8Array) {
        slide.addImage({data: imageDataUri(s), x: PPTX_W - 4.3, y: bodyY, w: 3.5, h: PPTX_H - bodyY - 0.6, sizing: {type: "contain", w: 3.5, h: PPTX_H - bodyY - 0.6}});
      }
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  return new Uint8Array(await pptx.write({outputType: "nodebuffer"}));
}

/** Bytes → data URI for pptxgenjs's addImage ({data}) — the sniffed
 * kind decides the mime, never the file name. */
function imageDataUri(s) {
  return `image/${s._imageKind === "jpeg" ? "jpeg" : "png"};base64,${toBase64(s._bytes)}`;
}

/** Bytes → base64 without Buffer (the plugin file avoids node:base64 for
 * no reason — plain chunked btoa keeps the builder engine-testable in
 * any runtime that ships btoa). */
function toBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Tool executors' shared helpers
// ---------------------------------------------------------------------------

/** The session's own working directory (the lumina-tools lesson: NEVER
 * ctx.location.directory — that is the server's cwd). */
async function sessionDirectory(ctx, sessionID) {
  if (!sessionID) return null;
  try {
    const info = await ctx.session.get({sessionID});
    const dir = info?.location?.directory ?? info?.info?.location?.directory;
    return typeof dir === "string" && dir.trim() ? dir : null;
  } catch {
    return null;
  }
}

/** Resolve a model-supplied IMAGE path (workspace image or an absolute
 * one anywhere) — images are read-only inputs, so no confinement.
 * Returns {abs} or {error}. */
async function resolveInside(p, directory) {
  const {path} = await nodeApis();
  const raw = typeof p === "string" ? p.trim() : "";
  if (!raw) return {error: "'path' is required"};
  if (raw.includes("\0")) return {error: "'path' contains a NUL character"};
  const abs = path.normalize(path.isAbsolute(raw) ? raw : path.join(directory, raw));
  return {abs};
}

/** Load image bytes for every image block/slide, decorating the entries
 * with _bytes/_imageKind. Returns an error string or null. */
async function preloadImages(items, directory) {
  const {fs} = await nodeApis();
  for (const item of items) {
    const raw = item.type === "image" ? item.path : item.image;
    if (!raw) continue;
    const resolved = await resolveInside(raw, directory);
    if (resolved.error) return `'${raw}': ${resolved.error}`;
    let bytes;
    try {
      bytes = new Uint8Array(await fs.promises.readFile(resolved.abs));
    } catch (e) {
      return `cannot read image '${raw}': ${String(e?.message ?? e)}`;
    }
    const sniffed = imageDimensions(bytes);
    if (!sniffed) {
      return `'${raw}' is not a supported image (PNG/JPEG only)`;
    }
    item._bytes = bytes;
    item._imageKind = sniffed.kind;
  }
  return null;
}

/** Write bytes to a path, creating parent directories. */
async function writeBytes(abs, bytes) {
  const {fs, path} = await nodeApis();
  await fs.promises.mkdir(path.dirname(abs), {recursive: true});
  await fs.promises.writeFile(abs, bytes);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function makeWriteDocument(engines) {
  return {
    enabled() {
      return true; // registered only when the engines loaded (setup gate)
    },

    tool(_options, ctx) {
      return {
        name: "write_document",
        description:
          "Create or overwrite a Word (.docx) or PowerPoint (.pptx) document at a path in the working directory, " +
          "from a structured block list YOU provide — the official way to produce office deliverables. NEVER write " +
          "scripts/code to generate office documents; this tool renders deterministically (fonts, tables, lists, " +
          "images) and the user gets a real file they can open in Word/WPS. For Word pass 'blocks' (ordered: " +
          "heading{level 1-3,text} / paragraph{text,bold?,italic?} / list{ordered,items[]} / table{header?,rows[][]} / " +
          "image{path,caption?}); for PowerPoint pass 'slides' (each: layout title|titleContent|twoContent|blank with " +
          "title?/subtitle?/bullets[{text,level 0|1}]?/image?/notes?). Image paths point at image files " +
          "(PNG/JPEG). The path's extension (.docx/.pptx) decides the format; overwriting rewrites the file. " +
          "After writing, ALWAYS reference the document in your reply as a markdown link whose target is its " +
          "path relative to the working directory — [文档.docx](./文档.docx) — the app renders it as a clickable " +
          "file chip that previews the document in the workspace panel.",
        input: {
          type: "object",
          properties: {
            path: {type: "string", description: "Document path — absolute, or relative to the working directory. Must end in .docx or .pptx."},
            blocks: {type: "array", description: "Word content blocks, in order (see tool description for the shapes)."},
            slides: {type: "array", description: "PowerPoint slides, in order (see tool description for the shapes)."},
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: {
          // Native tool — the codemode path has a step budget and
          // degrades to hallucinated text (the lumina-tools lesson).
          codemode: false,
        },
        execute: async (input, context) => {
          const sessionID = context?.sessionID;
          const directory = sessionID ? await sessionDirectory(ctx, sessionID) : null;
          if (!directory) return {error: "cannot resolve the working directory for this session"};
          const {path} = await nodeApis();
          const resolved = resolveDocumentPath(input?.path, directory, path);
          if (resolved.error) return {error: resolved.error};
          const isDocx = resolved.format === "docx";
          const validated = isDocx ? validateBlocks(input?.blocks) : validateSlides(input?.slides);
          if (validated.error) return {error: validated.error};
          const items = isDocx ? validated.blocks : validated.slides;
          // Every image must exist and be sniffer-supported BEFORE any
          // bytes hit the disk (a half-written deliverable is worse than
          // a clean error).
          const imageError = await preloadImages(items, directory);
          if (imageError) return {error: `image problem — ${imageError}`};
          let bytes;
          try {
            bytes = isDocx ? await buildDocxBytes(engines, validated.blocks) : await buildPptxBytes(engines, validated.slides);
          } catch (e) {
            return {error: `the document engine failed: ${String(e?.message ?? e)}`};
          }
          try {
            await writeBytes(resolved.abs, bytes);
          } catch (e) {
            return {error: `cannot write '${resolved.fileName}': ${String(e?.message ?? e)}`};
          }
          // The structure sidecar — the app's in-app preview reads it.
          const payload = isDocx ? {blocks: stripInternal(validated.blocks)} : {slides: stripInternal(validated.slides)};
          const sidecar = composeDocstruct(resolved.fileName, resolved.format, bytes.length, payload);
          try {
            const {fs} = await nodeApis();
            const sidecarDir = path.join(directory, ".lumina", "docstruct");
            await fs.promises.mkdir(sidecarDir, {recursive: true});
            await fs.promises.writeFile(path.join(sidecarDir, sidecarName(resolved.fileName)), sidecar, "utf8");
          } catch (e) {
            // Best-effort: the document itself is fine without a preview.
            console.warn(`[office-tools] sidecar write failed: ${e?.message ?? e}`);
          }
          return {
            content:
              `Wrote ${resolved.fileName} (${bytes.length} bytes, ${isDocx ? "Word" : "PowerPoint"}, ` +
              `${isDocx ? validated.blocks.length : validated.slides.length} ${isDocx ? "blocks" : "slides"}). ` +
              "The user can preview it in-app and open it in Word/WPS. Reference it in your reply as a markdown " +
              `link — [${resolved.fileName}](./${path.relative(directory, resolved.abs)}) — so the user gets a clickable preview chip.`,
          };
        },
      };
    },
  };
}

/** Drop the executor-private fields (_bytes/_imageKind) before a
 * structure array is serialized into the sidecar (wire-clean JSON). */
function stripInternal(items) {
  return items.map((item) => {
    const clean = {};
    for (const [key, value] of Object.entries(item)) {
      if (!key.startsWith("_")) clean[key] = value;
    }
    return clean;
  });
}

const readDocument = {
  enabled() {
    return true; // needs no engine — the zip reader rides node:zlib
  },

  tool(_options, ctx) {
    return {
      name: "read_document",
      description:
        "Read the readable content of an existing Word (.docx) or PowerPoint (.pptx) document in the working " +
        "directory and return it as markdown: headings map to #/##/###, tables to markdown tables, slide breaks " +
        "to '## Slide n' sections with speaker notes quoted. Style/layout is not preserved — this is content " +
        "extraction for understanding or rewriting a document. Documents this app generated read back exactly " +
        "(structure sidecar); foreign documents are parsed best-effort from the file itself.",
      input: {
        type: "object",
        properties: {
          path: {type: "string", description: "Document path — absolute, or relative to the working directory."},
        },
        required: ["path"],
        additionalProperties: false,
      },
      options: {
        codemode: false, // native — see write_document
      },
      execute: async (input, context) => {
        const sessionID = context?.sessionID;
        const directory = sessionID ? await sessionDirectory(ctx, sessionID) : null;
        if (!directory) return {error: "cannot resolve the working directory for this session"};
        const {path, fs} = await nodeApis();
        // Reads may point anywhere on disk (the user's own files); only
        // writes stay confined to the workspace.
        const resolved = resolveDocumentPath(input?.path, directory, path, {confine: false});
        if (resolved.error) return {error: resolved.error};
        // Sidecar hit? The app-generated fast path — exact structure.
        const sidecarPath = path.join(directory, ".lumina", "docstruct", sidecarName(resolved.fileName));
        try {
          const raw = await fs.promises.readFile(sidecarPath, "utf8");
          const parsed = JSON.parse(raw);
          if (parsed?.source === "office-tools" && parsed.file === resolved.fileName) {
            if (Array.isArray(parsed.blocks)) return {content: blocksToMarkdown(parsed.blocks)};
            if (Array.isArray(parsed.slides)) return {content: slidesToMarkdown(parsed.slides)};
          }
        } catch {
          // absent/unreadable/unparseable — fall through to the file.
        }
        // The document itself.
        let bytes;
        try {
          bytes = new Uint8Array(await fs.promises.readFile(resolved.abs));
        } catch (e) {
          return {error: `cannot read '${resolved.fileName}': ${String(e?.message ?? e)}`};
        }
        let entries;
        try {
          entries = await readZipEntries(bytes);
        } catch (e) {
          return {
            error:
              `'${resolved.fileName}' does not parse as a ${resolved.format === "docx" ? "Word" : "PowerPoint"} ` +
              `file (${String(e?.message ?? e)}) — if it is an old .doc/.ppt format, ask the user to re-save it as .${resolved.format}`,
          };
        }
        const {markdown, degraded} = resolved.format === "docx"
          ? docxToMarkdown(entries)
          : pptxToMarkdown(entries);
        if (!markdown.trim()) {
          return {error: `'${resolved.fileName}' contains no extractable text`};
        }
        return {content: degraded ? `${markdown}\n(note: extracted as plain text — the document's structure was not fully parseable)` : markdown};
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/** The resident tools. write_document is added only when the vendored
 * engines load (an engine-less install still reads documents). */
export default {
  id: "office-tools",
  async setup(ctx) {
    const options = ctx.options ?? {};
    const engines = await loadEngines();
    const tools = [readDocument];
    if (engines) tools.push(makeWriteDocument(engines));
    await ctx.tool.transform((editor) => {
      for (const t of tools) editor.add(t.tool(options, ctx));
    });
  },
};
