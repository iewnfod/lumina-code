// Lumina Code custom tools — the plugin host shipped with the app.
//
// Distribution: Lumina Code writes this file to
// `<global config>/plugins/lumina-tools/index.js` and references the
// directory from the global opencode.json's `plugins` array, passing
// per-tool options:
//
//   "plugins": [
//     { "package": "/home/me/.config/opencode/plugins/lumina-tools",
//       "options": { "vision": { "model": "providerID/modelID" } } }
//   ]
//
// The server (verified v2.0.11) hot-reloads plugins when the config
// changes, so toggling a tool or its model from Lumina Code's settings
// takes effect without a restart.
//
// Adding a tool: append one entry to TOOLS below. A ToolDef is
//   {
//     enabled(options) → bool
//         Per-tool gate; an unconfigured tool stays UNREGISTERED so models
//         never see a tool that cannot run (its absence is the signal).
//     agentId?: string
//         Id of the restricted helper agent the tool delegates to. The
//         agent itself is defined in the config's `agents` section by
//         Lumina Code (v2.0.11's agent transform has no add() — verified
//         live; see opencode/toolPluginConfig.ts, which owns
//         the config-side definition and keeps it in sync with the
//         plugin entry).
//     tool(options, ctx) → the definition handed to editor.add
//         (name / description / input schema / execute). Keep descriptions
//         written for the CALLING model — they are the model's only manual.
//   }
//
// v2.0.11 verified behaviors this file relies on:
//   - a plain-object default export loads (no @opencode/plugin import;
//     the default export MUST carry an `id` — a bare object is schema-
//     rejected, live-verified),
//   - ctx.tool.transform's editor.add works; ctx.session.{create, prompt,
//     wait, context, interrupt, switchAgent, get} exist,
//   - tool executors receive context.{sessionID, agent, signal} — the
//     CURRENT step's session and agent (schema/src/tool.ts at the tag;
//     switchAgent's REST twin verified live via /openapi.json),
//   - an interrupt does NOT reliably abort a plugin executor's
//     context.signal (live-observed 2026-09-28: a rejected work_submit's
//     executor kept polling and raced the resubmission's archive) — the
//     poll gates therefore carry the per-session GENERATION FENCE
//     (claimGate/gateIsCurrent below) instead of trusting the signal,
//   - the plugin is a SINGLE instance whose setup ctx.location.directory
//     is the SERVER's cwd, NOT each session's directory (live-verified) —
//     executors resolve per-session directories from
//     ctx.session.get({sessionID}).location.directory,
//   - DYNAMIC `await import("node:fs")` inside functions works
//     (live-verified; top-level static imports remain off-limits) — and
//     the server's HTTP fs API has read/list/find/experimental-write only,
//     NO delete/move, so this plugin is the only side that can maintain
//     the .lumina/tasks/ mirror or archive it,
//   - the "context" session hook's callback may be ASYNC and its event
//     carries sessionID (live-verified) — the active-plans digest resolves
//     the session's own directory inside the hook,
//   - ctx.session has NO delete — Lumina Code's frontend deletes helper
//     sessions via DELETE /api/session/{id} (see useSessions.ts),
//   - prompt files[] accepts {uri: "file:///abs/path"} attachments.
// Quirks are commented inline; do not "fix" them without re-testing
// against the pinned server.

/** Helper sessions created by these tools carry this marker so Lumina
 * Code can hide them from the sidebar and delete them when idle.
 * EVERY askModel() call stamps it — future delegate-tools inherit the
 * hiding/cleanup for free. */
const HELPER_MARKER = {source: "lumina-tools"};

// ---------------------------------------------------------------------------
// Reusable delegation core
// ---------------------------------------------------------------------------

/** "providerID/modelID" (Lumina Code's compact config form) → Model.Ref
 * the session endpoints expect. */
function parseModelRef(model) {
  const sep = model.indexOf("/");
  if (sep <= 0 || sep >= model.length - 1) return null;
  return {providerID: model.slice(0, sep), id: model.slice(sep + 1)};
}

/** file:// URI for an absolute path (spaces etc. percent-encoded, the
 * slashes the server's prompt-file reader expects left intact). */
function fileUri(absPath) {
  return "file://" + encodeURI(absPath);
}

/** The last assistant message's joined text parts — the reply of a
 * finished helper session. Defensive about the context shape because
 * session.context's item form is not part of the documented surface
 * (observed as {info: {role}, parts: [{type, text}]} on v2.0.11). */
function replyText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] ?? {};
    const role = m.info?.role ?? m.role ?? m.type;
    if (role !== "assistant") continue;
    const parts = m.parts ?? m.content ?? [];
    const texts = [];
    for (const p of parts) {
      if (p?.type === "text" && typeof p.text === "string" && p.text) texts.push(p.text);
    }
    const joined = texts.join("\n\n").trim();
    if (joined) return joined;
  }
  return "";
}

/**
 * Ask a model a one-shot question through a transient helper session —
 * the delegation primitive every "borrow another model's capability"
 * tool is built on. Creates the session (restricted agent + explicit
 * model + HELPER_MARKER metadata), prompts (optionally with file
 * attachments), waits for the turn to finish and returns the reply
 * text. The session itself is NOT deleted here (no delete in the plugin
 * API on v2.0.11) — Lumina Code's frontend watches the marker.
 *
 * `signal` (the tool executor's abort signal) interrupts the helper
 * session; `timeoutMs` is the belt-and-braces ceiling for GUI sanity.
 */
async function askModel(ctx, {agent, model, text, files, title, tool, signal, timeoutMs = 180_000}) {
  const session = await ctx.session.create({
    agent,
    model,
    title,
    metadata: {...HELPER_MARKER, tool},
  });
  const sessionID = session.id;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctx.session.interrupt({sessionID, continue: false}).catch(() => {});
  }, timeoutMs);
  const onAbort = () => {
    ctx.session.interrupt({sessionID, continue: false}).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, {once: true});
  try {
    await ctx.session.prompt({
      sessionID,
      text,
      ...(files?.length ? {files: files.map((f) => ({uri: f.uri, name: f.name}))} : {}),
    });
    await ctx.session.wait({sessionID});
    if (timedOut) throw new Error(`the model did not answer within ${timeoutMs / 1000}s`);
    if (signal?.aborted) throw new Error("cancelled");
    const messages = await ctx.session.context({sessionID});
    const reply = replyText(Array.isArray(messages) ? messages : []);
    if (!reply) throw new Error("the model returned no text");
    return reply;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Tool: vision (识图) — let text-only models see images
// ---------------------------------------------------------------------------

/** Image extensions the helper session's prompt-file path accepts
 * (mime inferred from the extension; the server reads the file itself). */
const IMAGE_MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

const vision = {
  agentId: "lumina-vision",

  enabled(options) {
    return typeof options?.vision?.model === "string" && parseModelRef(options.vision.model) !== null;
  },

  tool(options, ctx) {
    const modelRef = parseModelRef(options.vision.model);
    return {
      name: "vision",
      description:
        "Ask a vision-capable model about an image file and get its answer as text — a FALLBACK 'eye' " +
        "for models that cannot see images themselves (screenshots, photos, diagrams, charts). " +
        "Priority: if image content is already visible to you in this conversation, read it directly " +
        "and do NOT call this tool for it; decide by your own ability to view images. Call it only for " +
        "images you cannot view yourself: one referenced by path in the user's message — the note " +
        "'[image attachments saved as files — view them with the vision tool: [{\"name\": …, " +
        "\"path\": …}]]' maps each attached image's ORIGINAL name (what the user called it) to its " +
        "saved file — or an image file you find in the workspace. Pass a focused question; the tool " +
        "returns the other model's answer.",
      input: {
        type: "object",
        properties: {
          image: {
            type: "string",
            description: "Path of the image to inspect — absolute, or relative to the working directory.",
          },
          prompt: {
            type: "string",
            description: "The question the vision model should answer about the image.",
          },
        },
        required: ["image", "prompt"],
        additionalProperties: false,
      },
      options: {
        // Verified on v2.0.11: plugin tools default to CODE MODE exposure
        // (callable only as tools.vision inside the execute tool, whose
        // runtime has its own step budget and degrades to hallucinated
        // text when exhausted). codemode:false registers vision as a
        // NATIVE tool the model calls directly — the reliable path.
        codemode: false,
      },
      execute: async (input, context) => {
        const {image, prompt} = input ?? {};
        if (typeof image !== "string" || !image.trim() || typeof prompt !== "string" || !prompt.trim()) {
          return {error: "both 'image' (path) and 'prompt' (question) are required"};
        }
        const ext = image.toLowerCase().split(".").pop();
        if (!IMAGE_MIME_BY_EXT[ext]) {
          return {
            error: `unsupported image extension ".${ext}" — supported: ${Object.keys(IMAGE_MIME_BY_EXT).join(", ")}`,
          };
        }
        const abs = image.startsWith("/")
          ? image
          : `${ctx.location.directory}/${image.replace(/^\.\/+/, "")}`;
        try {
          const reply = await askModel(ctx, {
            agent: vision.agentId,
            model: modelRef,
            text: prompt,
            files: [{uri: fileUri(abs), name: abs.split("/").pop()}],
            title: `vision: ${abs.split("/").pop()}`,
            tool: "vision",
            signal: context?.signal,
          });
          return {content: reply};
        } catch (e) {
          return {error: String(e?.message ?? e)};
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: plan_mode — let the model switch this session into Plan Mode itself
// ---------------------------------------------------------------------------

/** OpenCode's Plan Mode IS the builtin `plan` primary agent (read-only
 * exploration; plan files writable; shell permission-controlled). The
 * runner re-resolves the session's agent for EVERY model step
 * (runner/llm.ts: advanceToStep → context.select → agents.select), so a
 * switchAgent issued from a tool executor takes effect on the NEXT step —
 * the continuation right after this tool's result already runs under the
 * plan agent's system prompt and restricted tools. No marker message is
 * persisted for agent switches (unlike model switches), so the tool card
 * below is the transcript's only record of the change.
 *
 * One-way on purpose: returning to build is the USER's decision (the
 * composer's mode picker) — a model that could unlock its own edit
 * permissions would defeat the point of planning first. */
const planMode = {
  // Always on while the plugin is loaded — plan_mode needs no per-tool
  // options (a proper tool marketplace replaces this gating later).
  enabled() {
    return true;
  },

  tool(_options, ctx) {
    return {
      name: "plan_mode",
      description:
        "Switch this session into plan mode — the read-only 'plan' agent — before starting work that deserves " +
        "planning: multiple files will be touched, there are design decisions to make, or the user asked for a " +
        "plan, review or analysis first. After this call your NEXT step continues under the plan agent with " +
        "explore/read tools only: investigate the codebase, weigh the options, then answer with a concrete " +
        "implementation plan. Do NOT call it for small, well-understood edits or questions that need no code " +
        "changes. Leaving plan mode is the user's decision — never promise to switch back yourself.",
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      options: {
        // Native tool like vision — see the codemode note there.
        codemode: false,
      },
      execute: async (_input, context) => {
        const sessionID = context?.sessionID;
        if (!sessionID) return {error: "no session context"};
        if (context.agent === "plan") {
          return {content: "This session is already in plan mode."};
        }
        try {
          await ctx.session.switchAgent({sessionID, agent: "plan"});
          return {
            content:
              "Plan mode is active: from your next step on, this session runs under the read-only 'plan' agent. " +
              "Continue by investigating the codebase and presenting an implementation plan; the user decides " +
              "when to return to build mode.",
          };
        } catch (e) {
          return {error: String(e?.message ?? e)};
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Plan documents on disk — pure naming/composition helpers
// ---------------------------------------------------------------------------
// The plan workflow's on-disk mirror lives under the session's directory:
//
//   .lumina/tasks/{slug}/plan.md      the newest submitted plan document
//   .lumina/tasks/{slug}/report.md    the newest submitted work report
//   .lumina/tasks/{slug}/tasks.md     the host-maintained task checklist
//   .lumina/tasks/{slug}/history/     one timestamped snapshot per submission
//   .lumina/archived/{slug}.zip       the acceptance archive (all of the above)
//
// Everything in this section is PURE (fs-free) and named-exported so
// node:test can exercise it directly (src/plugins/luminaTools.test.js;
// the server only ever reads the default export). The fs-touching halves
// live with the tool executors further down.

/** Filename-safe slug for a plan title. Unicode-aware (CJK titles stay
 * readable), lowercased, runs of anything else collapsed to dashes, capped
 * so long titles don't blow up paths. The algorithm MUST stay stable:
 * directory anchoring scans by this slug. */
export function planFileSlug(title) {
  const slug = String(title ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’‘]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "plan";
}

/** The task directory name for a title: the slug, then -2, -3… while the
 * probe reports the name taken (another session's plan with the same
 * title). Directories carry no date — the files inside do. */
export async function planDirName(title, exists) {
  const base = planFileSlug(title);
  let name = base;
  for (let n = 2; await exists(name); n++) name = `${base}-${n}`;
  return name;
}

/** history/ snapshot file name: `{kind}-YYYY-MM-DD-HHmm.md`, `-2`, `-3`…
 * on a same-stamp collision. kind is "plan" | "report". */
export async function historyFileName(kind, now, exists) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  let name = `${kind}-${stamp}.md`;
  for (let n = 2; await exists(name); n++) name = `${kind}-${stamp}-${n}.md`;
  return name;
}

/** The ownership anchor stamped into every file this plugin writes into a
 * task directory. Executors later find "their" directory by scanning
 * `{slug}*` entries for a matching session id — the transcript fold stays
 * stateless and a server restart cannot drift into another plan's
 * directory. */
export function anchorComment(sessionID) {
  return `<!-- lumina: session=${sessionID} -->`;
}

/** plan.md — the newest submitted plan document, EXACTLY as the model
 * authored it (the markdown already carries its own headings — never
 * prepend one). Every submission (even one later rejected) overwrites
 * it after snapshotting into history/. */
export function composePlanDoc(sessionID, plan) {
  return `${anchorComment(sessionID)}\n\n${String(plan ?? "").trim()}\n`;
}

/** report.md — the newest submitted work report, exactly as authored
 * (same no-added-heading rule and overwrite/snapshot semantics as
 * plan.md). */
export function composeReportDoc(sessionID, report) {
  return `${anchorComment(sessionID)}\n\n${String(report ?? "").trim()}\n`;
}

/** tasks.md — the HOST-maintained checklist, rewritten in full after every
 * task_complete / plan_amend so the file always mirrors the fold's state.
 * Its existence marks the directory as an APPROVED plan (a submitted-but-
 * never-approved plan carries plan.md + history only). */
export function composeTasksDoc(sessionID, title, items) {
  const lines = items.map((item) => {
    const box = item.status === "completed" ? "x" : item.status === "blocked" ? "!" : " ";
    const note = item.status === "blocked" && item.reason ? ` — blocked: ${item.reason}` : "";
    return `- [${box}] ${item.title}${note}`;
  });
  return (
    `${anchorComment(sessionID)}\n\n# Tasks — ${title}\n\n` +
    `> Maintained by Lumina Code from the session's task reports — manual edits are overwritten.\n\n` +
    `${lines.join("\n")}\n`
  );
}

/** CRC-32 (IEEE 802.3, polynomial 0xEDB88320) — table built lazily once;
 * buildStoredZip is the only consumer. */
let CRC_TABLE = null;
function crc32Table() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    table[n] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

function crc32Bytes(bytes) {
  const table = crc32Table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a STORED (uncompressed) zip archive with zero dependencies —
 * works everywhere the server runs (Windows has no zip.exe, Node has no
 * zip writer) and plan documents are tiny text files, so compression buys
 * nothing. entries: [{name, content}] with UTF-8 names (flag bit 11) and
 * UTF-8 text content; returns the complete .zip bytes. */
export function buildStoredZip(entries, now = new Date()) {
  const encoder = new TextEncoder();
  const year = Math.max(1980, now.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(String(entry.name));
    const dataBytes = encoder.encode(String(entry.content));
    const crc = crc32Bytes(dataBytes);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed: 2.0
    lv.setUint16(6, 0x0800, true); // general purpose flags: UTF-8 names
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true); // compressed size
    lv.setUint32(22, dataBytes.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // general purpose flags: UTF-8
    cv.setUint16(10, 0, true); // method: stored
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra field length
    cv.setUint16(32, 0, true); // file comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal file attributes
    cv.setUint32(38, 0, true); // external file attributes
    cv.setUint32(42, offset, true); // relative offset of local header
    central.set(nameBytes, 46);

    locals.push(local, dataBytes);
    centrals.push(central);
    offset += local.length + dataBytes.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true); // number of this disk
  ev.setUint16(6, 0, true); // disk with the central directory
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true); // central directory size
  ev.setUint32(16, offset, true); // central directory offset
  ev.setUint16(20, 0, true); // comment length

  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const chunk of [...locals, ...centrals, eocd]) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan documents on disk — the fs-touching half (executors only)
// ---------------------------------------------------------------------------
// Executors reach node:fs through DYNAMIC imports only (verified live on
// v2.0.11: plugin sources take no top-level static imports, but
// `await import("node:fs")` inside functions works — and the server's HTTP
// fs API has no delete/move, so the plugin is the ONLY side that can
// maintain this mirror). Every write is best-effort: disk state never
// blocks the workflow, failures ride along in the tool result text.

let NODE_APIS = null;
async function nodeApis() {
  if (!NODE_APIS) NODE_APIS = {fs: await import("node:fs"), path: await import("node:path")};
  return NODE_APIS;
}

/** The session's own working directory. NEVER ctx.location.directory —
 * verified live: the plugin is a single instance whose setup location is
 * the SERVER's cwd, not each session's directory. The session handle is
 * the authoritative source (defensive about both observed spellings,
 * same posture as the agent field in the approval poll). */
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

/** The task directory this session already owns under `<dir>/.lumina/tasks`:
 * any `{slug}`/`{slug}-N` entry whose plan.md or tasks.md carries this
 * session's anchor. Null when the session owns none (first submission, or
 * its directory was wiped) — the caller then allocates a fresh name.
 * Anchoring by session id keeps the transcript fold stateless: restarts
 * and same-title plans from other sessions cannot drift into the wrong
 * directory, and a rejected-then-revised resubmission reuses (overwrites)
 * the same directory. */
async function findOwnedTaskDir(fs, path, directory, slug, sessionID) {
  const root = path.join(directory, ".lumina", "tasks");
  let entries;
  try {
    entries = await fs.promises.readdir(root, {withFileTypes: true});
  } catch {
    return null; // no tasks root yet
  }
  const anchor = anchorComment(sessionID);
  const candidates = entries
    .filter((e) => e.isDirectory() && (e.name === slug || e.name.startsWith(`${slug}-`)))
    .map((e) => e.name)
    .sort();
  for (const name of candidates) {
    for (const file of ["plan.md", "tasks.md"]) {
      try {
        const content = await fs.promises.readFile(path.join(root, name, file), "utf8");
        if (content.startsWith(anchor)) return name;
      } catch {
        // missing/unreadable — try the next candidate
      }
    }
  }
  return null;
}

/** Resolve (or allocate) this session's task directory name for a title. */
async function ownedOrNewTaskDir(fs, path, directory, title, sessionID) {
  const slug = planFileSlug(title);
  const root = path.join(directory, ".lumina", "tasks");
  const owned = await findOwnedTaskDir(fs, path, directory, slug, sessionID);
  if (owned) return {root, dirName: owned};
  const dirName = await planDirName(title, (name) => fs.existsSync(path.join(root, name)));
  return {root, dirName};
}

/** Persist a plan SUBMISSION (approval or not): a timestamped history
 * snapshot plus the newest plan.md. Returns the directory name, or an
 * error string — callers surface it without blocking the workflow.
 * Exported for node:test coverage of the anchoring/collision/history
 * rules (the server ignores non-default exports). */
export async function writePlanSubmission(directory, sessionID, title, plan) {
  const {fs, path} = await nodeApis();
  const {root, dirName} = await ownedOrNewTaskDir(fs, path, directory, title, sessionID);
  const dir = path.join(root, dirName);
  const historyDir = path.join(dir, "history");
  await fs.promises.mkdir(historyDir, {recursive: true});
  const doc = composePlanDoc(sessionID, plan);
  const historyName = await historyFileName("plan", new Date(), (name) =>
    fs.existsSync(path.join(historyDir, name)),
  );
  await fs.promises.writeFile(path.join(historyDir, historyName), doc, "utf8");
  await fs.promises.writeFile(path.join(dir, "plan.md"), doc, "utf8");
  return dirName;
}

/** Write/refresh tasks.md — called on approval and after every progress
 * event (task_complete / plan_amend) so the file always mirrors the fold.
 * Its existence is what marks a directory as an APPROVED plan (callers
 * only invoke this once the transcript shows an approved plan; a
 * submitted-but-rejected plan keeps plan.md + history only). Best-effort:
 * returns the directory name, or null when the write failed (logged to
 * the server log — the workflow itself never blocks on disk state).
 * Exported for node:test coverage alongside writePlanSubmission. */
export async function writeTasksState(directory, sessionID, state) {
  try {
    const {fs, path} = await nodeApis();
    const {root, dirName} = await ownedOrNewTaskDir(fs, path, directory, state.title, sessionID);
    const dir = path.join(root, dirName);
    await fs.promises.mkdir(dir, {recursive: true});
    await fs.promises.writeFile(path.join(dir, "tasks.md"), composeTasksDoc(sessionID, state.title, state.items), "utf8");
    return dirName;
  } catch (e) {
    console.warn(`[lumina-tools] tasks.md refresh failed: ${e?.message ?? e}`);
    return null;
  }
}

/** Persist a work-report SUBMISSION (accepted or not): a timestamped
 * history snapshot plus the newest report.md in the session's anchored
 * task directory. Exported for node:test coverage like its plan twin. */
export async function writeReportSubmission(directory, sessionID, title, report) {
  const {fs, path} = await nodeApis();
  const {root, dirName} = await ownedOrNewTaskDir(fs, path, directory, title, sessionID);
  const dir = path.join(root, dirName);
  const historyDir = path.join(dir, "history");
  await fs.promises.mkdir(historyDir, {recursive: true});
  const doc = composeReportDoc(sessionID, report);
  const historyName = await historyFileName("report", new Date(), (name) =>
    fs.existsSync(path.join(historyDir, name)),
  );
  await fs.promises.writeFile(path.join(historyDir, historyName), doc, "utf8");
  await fs.promises.writeFile(path.join(dir, "report.md"), doc, "utf8");
  return dirName;
}

/** The acceptance marker's fixed path — derived from the session's
 * directory and id alone (NOT the task directory: the GUI cannot know its
 * collision suffix, but both sides can derive this path). The GUI's
 * acceptance card writes it; the work_submit executor polls it. */
function reviewMarkerPath(path, directory, sessionID) {
  return path.join(directory, ".lumina", "review", `${sessionID}.json`);
}

/** Collect a task directory's files as zip entries: the three documents
 * plus every history snapshot (the archive IS the plan's complete
 * record). Dotfiles (e.g. a lingering .review.json) are excluded, and
 * history entries carry their subdirectory name so the tree survives. */
async function collectArchiveEntries(fs, path, dir) {
  const entries = [];
  for (const name of ["plan.md", "report.md", "tasks.md"]) {
    try {
      entries.push({name, content: await fs.promises.readFile(path.join(dir, name), "utf8")});
    } catch {
      // absent (e.g. a write failed earlier) — the archive keeps what exists
    }
  }
  const historyDir = path.join(dir, "history");
  let history = [];
  try {
    history = await fs.promises.readdir(historyDir);
  } catch {
    history = [];
  }
  for (const name of history.sort()) {
    if (name.startsWith(".")) continue;
    try {
      entries.push({
        name: `history/${name}`,
        content: await fs.promises.readFile(path.join(historyDir, name), "utf8"),
      });
    } catch {
      // unreadable — skip
    }
  }
  return entries;
}

/** ARCHIVE the session's task directory on acceptance: write the complete
 * record (plan.md + report.md + tasks.md + history/) as a stored zip into
 * .lumina/archived/ (via a .tmp + rename so a partial write never poses
 * as an archive), then remove the directory — acceptance is terminal.
 * Returns the zip path, or an error string. Exported for node:test. */
export async function archiveTaskDirectory(directory, sessionID, title) {
  const {fs, path} = await nodeApis();
  const {root, dirName} = await ownedOrNewTaskDir(fs, path, directory, title, sessionID);
  const dir = path.join(root, dirName);
  if (!fs.existsSync(dir)) return {error: `no task directory at ${dirName}`};
  const entries = await collectArchiveEntries(fs, path, dir);
  const archivedRoot = path.join(directory, ".lumina", "archived");
  await fs.promises.mkdir(archivedRoot, {recursive: true});
  let zipName = `${dirName}.zip`;
  for (let n = 2; fs.existsSync(path.join(archivedRoot, zipName)); n++) zipName = `${dirName}-${n}.zip`;
  const finalPath = path.join(archivedRoot, zipName);
  const tmpPath = `${finalPath}.tmp`;
  await fs.promises.writeFile(tmpPath, buildStoredZip(entries));
  await fs.promises.rename(tmpPath, finalPath);
  await fs.promises.rm(dir, {recursive: true, force: true});
  return {path: finalPath, zipName};
}

/** Scan `<dir>/.lumina/tasks/<name>/tasks.md` files and summarize the
 * directory's unarchived (approved) plans for the model's system context
 * — verified live that the hook callback may be async and
 * event.sessionID resolves the session's OWN directory. A new session
 * learns it can resume a plan ("continue the plan"), and a
 * context-compacted session re-learns where the plan documents live.
 * Directories without tasks.md are skipped: they hold
 * submitted-but-never-approved plans. Null when there is nothing to
 * report. (Never write a glob with an inner star-slash in a block
 * comment — it closes the comment early; this very bug shipped once.) */
async function activePlansNote(ctx, sessionID) {
  if (!sessionID) return null;
  const directory = await sessionDirectory(ctx, sessionID);
  if (!directory) return null;
  const {fs, path} = await nodeApis();
  const root = path.join(directory, ".lumina", "tasks");
  let entries;
  try {
    entries = await fs.promises.readdir(root, {withFileTypes: true});
  } catch {
    return null;
  }
  const lines = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    let doc;
    try {
      doc = await fs.promises.readFile(path.join(root, entry.name, "tasks.md"), "utf8");
    } catch {
      continue; // no tasks.md → not an approved plan
    }
    const title = (/# Tasks — (.+)$/m.exec(doc)?.[1] ?? "").trim() || entry.name;
    const done = (doc.match(/^- \[x\] /gm) ?? []).length;
    const blocked = (doc.match(/^- \[!\] /gm) ?? []).length;
    const open = (doc.match(/^- \[ \] /gm) ?? []).length;
    const state =
      open + blocked > 0
        ? `${done}/${done + open + blocked} done, ${open + blocked} remaining`
        : `all ${done} tasks done — awaiting the user's acceptance review`;
    lines.push(
      `- "${title}" — ${state} (documents: .lumina/tasks/${entry.name}/ — plan.md holds the approved plan, ` +
        "report.md the last work report)",
    );
  }
  if (lines.length === 0) return null;
  return (
    "Active plans in this directory (Lumina Code plan workflow — the user may ask you to continue one; " +
    "read its documents first):\n" +
    lines.join("\n")
  );
}

// ---------------------------------------------------------------------------
// Plan workflow: plan_submit / task_complete / plan_amend
// ---------------------------------------------------------------------------
// The plan-driven workflow: the plan agent submits a plan document + its
// ordered task list for USER APPROVAL (a permission "ask" rule Lumina Code
// writes into the config's agents.plan — approval unblocks the executor),
// approval switches the session to build, and execution reports progress
// strictly in order. Validation state is DERIVED FROM THE TRANSCRIPT on
// every call (ctx.session.context): the last COMPLETED plan_submit part
// defines the active list, subsequent completed task_complete/plan_amend
// parts advance it — no plugin-side mutable state to lose on restart or
// drift out of sync. Subagent child sessions scope themselves out for
// free: their transcripts hold no plan_submit, so task_complete there
// fails with "no approved plan".

/** Task titles are compared after this normalization — whitespace runs
 * collapse so wrapped/retyped copies still match, everything else
 * (including case) is exact. */
function normalizeTitle(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ");
}

/** The string[] of a tool input, or null when the value isn't one. */
function asStringArray(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const item of v) {
    if (typeof item !== "string" || !item.trim()) return null;
    out.push(item);
  }
  return out;
}

/** Derived plan state: {title, items: [{title, status, reason?}]} with
 * status "pending" | "completed" | "blocked". Items keep their historical
 * order; the NEXT open task is the first "pending" entry. */
function applyTaskEvent(state, input) {
  const title = normalizeTitle(input?.title);
  const next = state.items.find((i) => i.status === "pending");
  if (!next || title !== next.title) return; // a rejected call — ignore
  if (input?.blocked) {
    next.status = "blocked";
    if (typeof input.reason === "string" && input.reason.trim()) next.reason = input.reason.trim();
  } else {
    next.status = "completed";
  }
}

/** Rebuild the plan state from a session's transcript. Part shape on the
 * server-side context read is not part of the documented surface
 * (observed {info, parts}; tool parts defensively read several spellings)
 * — same posture as replyText above. Returns null when the session has
 * no APPROVED plan (never submitted, or the last submission errored). */
async function derivePlanState(ctx, sessionID) {
  let messages;
  try {
    messages = await ctx.session.context({sessionID});
  } catch {
    return null;
  }
  return planStateFromEntries(toolEntries(messages));
}

/** Tool-call entries {name, input, ok} in transcript order — shared by
 * the state derivation above. */
function toolEntries(messages) {
  const entries = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const msg = m ?? {};
    const parts = msg.parts ?? msg.content;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (!p || typeof p !== "object" || p.type !== "tool") continue;
      const state = p.state ?? {};
      entries.push({
        name: p.name ?? p.tool,
        input: state.input ?? p.input,
        ok: state.status === "completed" || state.status === "success",
      });
    }
  }
  return entries;
}

/** The fold itself, over normalized entries — kept separate so the
 * frontend twin (sessionActivity.ts) mirrors the exact same semantics. */
function planStateFromEntries(entries) {
  let state = null;
  for (const e of entries) {
    if (!e.ok || !e.input || typeof e.input !== "object") continue;
    if (e.name === "plan_submit") {
      const todos = asStringArray(e.input.todos);
      if (typeof e.input.title === "string" && e.input.title.trim() && todos && todos.length > 0) {
        state = {
          title: e.input.title.trim(),
          items: todos.map((t) => ({title: normalizeTitle(t), status: "pending"})),
        };
      }
    } else if (e.name === "task_complete" && state) {
      applyTaskEvent(state, e.input);
    } else if (e.name === "work_submit" && state) {
      // A SUCCESSFUL work_submit means the user accepted the work and the
      // executor archived the plan — acceptance is terminal (a rejected
      // or timed-out submission errors the part and leaves the plan open).
      if (e.ok) state.archived = true;
    } else if (e.name === "plan_amend" && state) {
      const todos = asStringArray(e.input.todos);
      if (todos) {
        const history = state.items.filter((i) => i.status !== "pending");
        state = {
          title: state.title,
          items: [...history, ...todos.map((t) => ({title: normalizeTitle(t), status: "pending"}))],
        };
      }
    }
  }
  return state;
}

/** "[x] 1. title" checklist — every tool result echoes it so a
 * context-compacted model can always re-read the plan's state. */
function renderChecklist(state) {
  const lines = state.items.map((item, i) => {
    const glyph = item.status === "completed" ? "[x]" : item.status === "blocked" ? "[!]" : "[ ]";
    const note = item.status === "blocked" && item.reason ? ` — blocked: ${item.reason}` : "";
    return `${i + 1}. ${glyph} ${item.title}${note}`;
  });
  return lines.join("\n");
}

/** Host identity pushed into every model call alongside PLAN_PROTOCOL.
 * Without this, the server's own prompt says only "OpenCode" and a model
 * running inside Lumina Code cannot know its actual harness (the desktop
 * GUI, not the TUI). This plugin is installed EXCLUSIVELY by Lumina Code
 * (opencode/useLuminaTools.ts), so its presence is the reliable signal. */
const HOST_IDENTITY =
  "Harness identity: you are running inside Lumina Code — a desktop GUI client for OpenCode " +
  "(Tauri + React), NOT the OpenCode TUI or CLI. When asked which harness or app you run in, " +
  "answer \"Lumina Code\"; the underlying server and agent machinery is OpenCode's.";

/** The system-prompt protocol pushed into every model call via the
 * "context" session hook (v2.0.11 ships hooks — verified by binary
 * inspection; setup probes the method at runtime and degrades to
 * tool-description-only enforcement when absent). */
const PLAN_PROTOCOL =
  "Plan workflow protocol: (1) In plan mode, a plan is NOT complete until you call plan_submit with the " +
  "full plan document and its ordered task list, then STOP — the call blocks until the user approves; never " +
  "produce anything else after submitting. Task titles must be SHORT: a few words each, never sentences — " +
  "they are tracked verbatim and displayed as a checklist. Approval switches the session to build mode " +
  "automatically; a rejection returns the plan to you for revision. (2) In build mode, work through the " +
  "approved tasks strictly in order. After genuinely finishing a task, call task_complete with the task's " +
  "title copied EXACTLY, character for character — mismatched or out-of-order titles are rejected. If a task " +
  "cannot be finished, call task_complete with blocked: true and a reason instead of claiming completion. If " +
  "the remaining tasks need adding, removing or rewording, call plan_amend with the new remaining list. " +
  "Once EVERY task is settled, call work_submit with a truthful completion report — what was done, how it was " +
  "verified (tests and their outcome, manual checks) and known gaps; it blocks until the user has TESTED the " +
  "work themselves, and a completed plan is archived only on their acceptance. Never claim progress or " +
  "verification you have not made. (3) Skip all of this for single-step answers and trivial edits.";

/** Route A approval gate timing: how often the blocked executor re-reads
 * the session's agent (approval IS the agent switch — Lumina Code's
 * approval card calls switchAgent "build"), and how long it waits for a
 * user who walked away. */
const PLAN_APPROVAL_POLL_MS = 400;
const PLAN_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** sleep that also resolves on abort — the poll loop then observes
 * signal.aborted and returns the rejection. */
function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, {once: true});
  });
}

/** Per-session GATE GENERATIONS: each new plan_submit / work_submit claims
 * the session's gate, and any older poll loop observes it has been
 * superseded and exits at its next tick. Needed because an interrupt does
 * NOT reliably abort a plugin executor's context.signal on v2.0.11
 * (live-observed 2026-09-28: a rejected work_submit's executor kept
 * polling, then raced the resubmission's archive — both wrote the .tmp,
 * one rename won, the loser ENOENT'd; a worse ordering has the zombie
 * consume the approval marker and starve the real gate into its 10-minute
 * timeout). A new gate's claim always precedes the user's decision by
 * seconds (the card must render and be clicked), while a zombie survives
 * at most one PLAN_APPROVAL_POLL_MS tick past the claim — the fence
 * closes the race without depending on signal semantics. One counter per
 * session suffices: the two gates never legitimately run concurrently
 * (the plan gate runs in plan mode, the work gate in build). The map
 * holds one number per session and is deliberately never cleaned. */
const gateGenerations = new Map();

/** Claim the session's gate, superseding any older poll loop. */
export function claimGate(sessionID) {
  const next = (gateGenerations.get(sessionID) ?? 0) + 1;
  gateGenerations.set(sessionID, next);
  return next;
}

/** Whether `gen` is still the session's current gate — false once a newer
 * submission claimed it (the caller is a zombie and must stop). */
export function gateIsCurrent(sessionID, gen) {
  return gateGenerations.get(sessionID) === gen;
}

const planSubmit = {
  // Always on — the workflow's entry point, no per-tool options.
  enabled() {
    return true;
  },

  tool(_options, ctx) {
    return {
      name: "plan_submit",
      description:
        "Submit your implementation plan for user approval — the ONLY way a plan becomes executable. Call it " +
        "when your investigation is done and the plan is concrete, and STOP after calling it: the call BLOCKS " +
        "until the user decides (approval switches this session to build mode automatically; rejection returns " +
        "the plan to you for revision). 'title' is a short plan name; 'plan' is the complete markdown document " +
        "the user will read and approve; 'todos' is the ordered task list — SHORT imperative titles (a few " +
        "words each, never sentences), mutually distinct, because each title is a verbatim identifier you must " +
        "later copy EXACTLY into task_complete. Only callable while this session is in plan mode.",
      input: {
        type: "object",
        properties: {
          title: {type: "string", description: "Short name of the plan."},
          plan: {type: "string", description: "The full plan document, markdown."},
          todos: {
            type: "array",
            items: {type: "string"},
            description: "Ordered task titles; each is later reported verbatim via task_complete.",
          },
        },
        required: ["title", "plan", "todos"],
        additionalProperties: false,
      },
      options: {
        // Native tool like vision — see the codemode note there. The
        // approval gate is the config's agents.plan permission "ask"
        // rule (toolPluginConfig.ts): the executor below runs only
        // AFTER the user approved.
        codemode: false,
      },
      execute: async (input, context) => {
        if (context?.agent !== "plan") {
          return {error: "plan_submit is only available while this session is in plan mode"};
        }
        const title = typeof input?.title === "string" ? input.title.trim() : "";
        const plan = typeof input?.plan === "string" ? input.plan : "";
        const todos = asStringArray(input?.todos);
        if (!title) return {error: "'title' (a short plan name) is required"};
        if (!plan.trim()) return {error: "'plan' (the full markdown plan document) is required"};
        if (!todos || todos.length === 0) {
          return {error: "'todos' must be a non-empty array of task titles"};
        }
        const normalized = todos.map(normalizeTitle);
        if (new Set(normalized).size !== normalized.length) {
          return {error: "task titles must be unique — later task_complete calls identify tasks by title"};
        }
        const sessionID = context.sessionID;
        // Persist the submission BEFORE the gate: a timestamped history
        // snapshot plus the newest plan.md (rejected revisions stay
        // reviewable on disk — the anchor comment ties the directory to
        // this session, so a revised resubmission overwrites the same
        // one). Best-effort: a failure rides along in the result.
        const directory = await sessionDirectory(ctx, sessionID);
        let planDir = null;
        let saveNote = "";
        if (directory) {
          try {
            planDir = await writePlanSubmission(directory, sessionID, title, plan);
          } catch (e) {
            saveNote = `\n(warning: the plan document could not be saved: ${String(e?.message ?? e)})`;
          }
        }
        // Route A approval gate: v2.0.11 has NO execution-time permission
        // check for plugin tools (binary-verified: options.permission only
        // filters tool visibility; asking is builtin-internal), so the
        // executor itself blocks until the user decides. Approval ARRIVES
        // as the agent switch (Lumina Code's approval card calls
        // switchAgent "build" — the gate opening IS the approval);
        // rejection arrives as this executor's abort signal (the card
        // interrupts the session).
        const myGen = claimGate(sessionID);
        const deadline = Date.now() + PLAN_APPROVAL_TIMEOUT_MS;
        let agent = "plan";
        try {
          for (;;) {
            if (context.signal?.aborted) break;
            // Superseded by a newer submission (see gateGenerations) —
            // exit BEFORE reading the agent so a zombie always leaves
            // with agent === "plan" and lands in the rejection branch
            // below (it must never write tasks.md).
            if (!gateIsCurrent(sessionID, myGen)) break;
            const info = await ctx.session.get({sessionID});
            agent = info?.agent ?? info?.info?.agent ?? "plan";
            if (typeof agent === "string" && agent !== "plan") break;
            if (Date.now() >= deadline) {
              return {
                error:
                  "the user did not respond to this plan within 10 minutes — do NOT start executing. " +
                  "Stop and wait for their guidance.",
              };
            }
            await sleepAbortable(PLAN_APPROVAL_POLL_MS, context.signal);
          }
        } catch (e) {
          if (!context.signal?.aborted) {
            return {error: `waiting for approval failed: ${String(e?.message ?? e)}`};
          }
        }
        if (context.signal?.aborted || agent === "plan") {
          return {
            error:
              "The user REJECTED this plan (or interrupted the wait). Do not start executing. " +
              "Wait for their guidance, or revise the plan and call plan_submit again.",
          };
        }
        const state = {title, items: normalized.map((t) => ({title: t, status: "pending"}))};
        // Approval makes the plan executable → its directory becomes an
        // APPROVED one: tasks.md appears (host-maintained from here on).
        if (directory) await writeTasksState(directory, sessionID, state);
        return {
          content:
            "Plan approved — the user opened the gate and this session now runs in build mode. Execute the " +
            "tasks strictly in order; after finishing each, call task_complete with its EXACT title. Task list:\n" +
            renderChecklist(state) +
            (planDir ? `\n(plan documents saved under .lumina/tasks/${planDir}/)` : "") +
            saveNote,
        };
      },
    };
  },
};

const taskComplete = {
  enabled() {
    return true;
  },

  tool(_options, ctx) {
    return {
      name: "task_complete",
      description:
        "Report progress on the approved plan by marking a task done. Give the task's title EXACTLY as it " +
        "appears in the approved list — copied character for character: the call is REJECTED unless it matches " +
        "the next open task, in order (no skipping, no revisiting settled tasks). If the task cannot be " +
        "finished, pass blocked: true with a reason instead of claiming completion. Call it once per task, " +
        "after the work for that task is genuinely done.",
      input: {
        type: "object",
        properties: {
          title: {type: "string", description: "The task's exact title from the approved list."},
          blocked: {type: "boolean", description: "True when the task could not be finished."},
          reason: {type: "string", description: "Why the task is blocked (required when blocked)."},
        },
        required: ["title"],
        additionalProperties: false,
      },
      options: {
        codemode: false, // native — see the codemode note on vision
      },
      execute: async (input, context) => {
        if (context?.agent === "plan") {
          return {error: "task_complete is not available in plan mode — the plan is not approved yet"};
        }
        const title = normalizeTitle(input?.title);
        if (!title) return {error: "'title' (the exact task title) is required"};
        if (input?.blocked && !(typeof input.reason === "string" && input.reason.trim())) {
          return {error: "a blocked task needs a 'reason'"};
        }
        const state = await derivePlanState(ctx, context?.sessionID);
        if (!state) {
          return {error: "no approved plan in this session — a plan becomes executable only after plan_submit is approved"};
        }
        if (state.archived) {
          return {error: "this plan is archived (its work was accepted) — start a NEW plan for further work"};
        }
        const next = state.items.find((i) => i.status === "pending");
        if (!next) {
          return {error: "all tasks are already settled:\n" + renderChecklist(state)};
        }
        if (title === next.title) {
          applyTaskEvent(state, input);
          const settled = state.items.filter((i) => i.status !== "pending").length;
          const head =
            input?.blocked
              ? `Task marked BLOCKED: ${title}`
              : settled === state.items.length
                ? "Task completed — ALL tasks settled. Finish by submitting the completion report via work_submit."
                : "Task completed.";
          // Mirror the new state into the task directory's tasks.md
          // (full rewrite — restarts catch up automatically).
          const directory = await sessionDirectory(ctx, context?.sessionID);
          if (directory) await writeTasksState(directory, context.sessionID, state);
          return {content: `${head} Task list:\n${renderChecklist(state)}`};
        }
        if (state.items.some((i) => i.status !== "pending" && i.title === title)) {
          return {
            error: `'${input.title}' was already settled earlier — tasks are settled once. The next open task is:\n    ${next.title}`,
          };
        }
        return {
          error:
            `title mismatch — '${input.title}' is not the next open task (titles must match exactly, in order). ` +
            `The next open task is:\n    ${next.title}\nCopy it character for character into task_complete. Task list:\n` +
            renderChecklist(state),
        };
      },
    };
  },
};

const planAmend = {
  enabled() {
    return true;
  },

  tool(_options, ctx) {
    return {
      name: "plan_amend",
      description:
        "Replace the REMAINING (not yet completed or blocked) tasks of the approved plan with a new list — use " +
        "it when execution reveals tasks must be added, removed or reworded. Settled tasks stay as history. " +
        "After an amend, the next task_complete must match the first entry of the new list. An empty array " +
        "withdraws the remaining work (plan considered finished).",
      input: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {type: "string"},
            description: "The new remaining task list, in execution order (may be empty).",
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
      options: {
        codemode: false, // native — see the codemode note on vision
      },
      execute: async (input, context) => {
        if (context?.agent === "plan") {
          return {error: "plan_amend is not available in plan mode"};
        }
        const todos = asStringArray(input?.todos);
        if (!todos) return {error: "'todos' must be an array of task titles (empty allowed)"};
        const state = await derivePlanState(ctx, context?.sessionID);
        if (!state) {
          return {error: "no approved plan in this session to amend"};
        }
        if (state.archived) {
          return {error: "this plan is archived (its work was accepted) — start a NEW plan instead of amending"};
        }
        const normalized = todos.map(normalizeTitle);
        if (new Set(normalized).size !== normalized.length) {
          return {error: "task titles must be unique"};
        }
        const history = state.items.filter((i) => i.status !== "pending");
        const next = {
          title: state.title,
          items: [...history, ...normalized.map((t) => ({title: t, status: "pending"}))],
        };
        // Mirror the amended list into tasks.md (full rewrite).
        const directory = await sessionDirectory(ctx, context?.sessionID);
        if (directory) await writeTasksState(directory, context.sessionID, next);
        return {
          content:
            (normalized.length === 0
              ? "Remaining tasks withdrawn — all tasks settled. Finish by submitting the completion report via work_submit. Settled history:\n"
              : "Plan amended. The next task_complete must match the first open task. Task list:\n") +
            renderChecklist(next),
        };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: work_submit — the acceptance gate after the last task
// ---------------------------------------------------------------------------

/** Archival certifies "the user TESTED this and it works" — never the
 * AI's own claim of completion (automated tests miss uncovered details).
 * So the plan does not finish on its own when the last task settles: the
 * model must submit a completion report, and THIS executor blocks until
 * the user decides. Approval arrives as the marker file the GUI's
 * acceptance card writes (.lumina/review/{sessionID}.json — a fixed path
 * both sides derive without knowing the task directory's collision
 * suffix); rejection arrives as the abort signal, exactly like the plan
 * approval gate. On approval the plan directory is ARCHIVED (see the
 * archive step inside the executor). */
const workSubmit = {
  enabled() {
    return true;
  },

  tool(_options, ctx) {
    return {
      name: "work_submit",
      description:
        "Submit the completion report for the approved plan — the ONLY way a plan finishes. Call it once EVERY " +
        "task is settled (none pending): report truthfully what was done, how it was verified (tests run and " +
        "their outcome, manual checks performed) and any known gaps or follow-ups. The call BLOCKS until the " +
        "user has tested the work themselves: acceptance archives the plan; a rejection returns the work to you " +
        "for fixes, after which you submit an updated report. Never call it before all tasks are settled, and " +
        "never claim verification you did not perform.",
      input: {
        type: "object",
        properties: {
          report: {
            type: "string",
            description: "The completion report as markdown: what was done, how it was verified, known gaps.",
          },
        },
        required: ["report"],
        additionalProperties: false,
      },
      options: {
        codemode: false, // native — see the codemode note on vision
      },
      execute: async (input, context) => {
        if (context?.agent === "plan") {
          return {error: "work_submit is not available in plan mode — finish the plan first"};
        }
        const report = typeof input?.report === "string" ? input.report.trim() : "";
        if (!report) return {error: "'report' (the completion report markdown) is required"};
        const sessionID = context.sessionID;
        const state = await derivePlanState(ctx, sessionID);
        if (!state) {
          return {error: "no approved plan in this session"};
        }
        if (state.archived) {
          return {error: "this plan is already accepted and archived — start a NEW plan for further work"};
        }
        const open = state.items.filter((i) => i.status === "pending" || i.status === "blocked");
        if (open.length > 0) {
          return {
            error:
              "the plan still has unsettled tasks — settle every task (complete or blocked-report it) before " +
              "submitting the completion report. Task list:\n" +
              renderChecklist(state),
          };
        }
        const directory = await sessionDirectory(ctx, sessionID);
        if (!directory) {
          return {error: "cannot resolve the working directory for the acceptance gate — try again shortly"};
        }
        // Persist the submission first (history snapshot + newest
        // report.md) — a later-rejected revision stays reviewable on disk.
        let saveNote = "";
        try {
          await writeReportSubmission(directory, sessionID, state.title, report);
        } catch (e) {
          saveNote = `\n(warning: the report could not be saved: ${String(e?.message ?? e)})`;
        }
        // Prepare the acceptance channel: the marker directory, cleared of
        // any stale marker a timed-out earlier wait left behind.
        const {fs, path} = await nodeApis();
        const marker = reviewMarkerPath(path, directory, sessionID);
        try {
          await fs.promises.mkdir(path.dirname(marker), {recursive: true});
          await fs.promises.rm(marker, {force: true});
        } catch (e) {
          return {error: `cannot prepare the acceptance marker: ${String(e?.message ?? e)}`};
        }
        // The gate itself — Route A twin of plan_submit's approval poll,
        // claimed per generation: a rejected earlier executor may still be
        // polling this marker (interrupts don't reliably abort
        // context.signal), and it must not steal the approval or archive.
        const myGen = claimGate(sessionID);
        const deadline = Date.now() + PLAN_APPROVAL_TIMEOUT_MS;
        let approved = false;
        try {
          for (;;) {
            if (context.signal?.aborted) break;
            if (!gateIsCurrent(sessionID, myGen)) break;
            if (fs.existsSync(marker)) {
              approved = true;
              break;
            }
            if (Date.now() >= deadline) {
              return {
                error:
                  "the user did not respond to the completion report within 10 minutes — the plan stays open. " +
                  "Do NOT start new work; stop and wait for their guidance.",
              };
            }
            await sleepAbortable(PLAN_APPROVAL_POLL_MS, context.signal);
          }
        } catch (e) {
          if (!context.signal?.aborted) {
            return {error: `waiting for acceptance failed: ${String(e?.message ?? e)}`};
          }
        }
        // Only the CURRENT gate touches the marker — a superseded zombie
        // winding down leaves this gate's channel alone.
        if (gateIsCurrent(sessionID, myGen)) {
          await fs.promises.rm(marker, {force: true}).catch(() => {});
        }
        if (context.signal?.aborted || !approved) {
          return {
            error:
              "The user REJECTED this work (or interrupted the wait) — the work did not pass their testing. " +
              "Fix the issues they report, then call work_submit again with an updated report.",
          };
        }
        // Acceptance is terminal: archive the plan's complete record
        // (documents + every history snapshot) as a zip and remove the
        // task directory. Best-effort — a failure rides along but the
        // acceptance itself stands.
        let archiveNote = "";
        try {
          const archived = await archiveTaskDirectory(directory, sessionID, state.title);
          archiveNote =
            archived && !archived.error
              ? `\nThe plan is archived at ${archived.path}.`
              : `\n(warning: archival failed: ${archived?.error ?? "unknown"})`;
        } catch (e) {
          archiveNote = `\n(warning: archival failed: ${String(e?.message ?? e)})`;
        }
        return {
          content: "Work accepted — the user tested the delivery and approved it." + archiveNote + saveNote,
        };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/** The resident tools. Order matters only for tool-list presentation. */
const TOOLS = [vision, planMode, planSubmit, taskComplete, planAmend, workSubmit];

export default {
  id: "lumina-tools",
  async setup(ctx) {
    const options = ctx.options ?? {};
    const active = TOOLS.filter((t) => {
      try {
        return t.enabled(options);
      } catch {
        return false;
      }
    });
    await ctx.tool.transform((editor) => {
      for (const t of active) editor.add(t.tool(options, ctx));
    });
    // The host identity + plan-workflow protocol ride the "context"
    // session hook when the server offers it (v2.0.11 does —
    // binary-verified; the docs' event.system.push shape). Verified live:
    // the callback may be ASYNC and event.sessionID identifies the
    // session, so the plans note below resolves the session's own
    // directory. Absent the hook, enforcement degrades to the tool
    // descriptions above.
    try {
      if (typeof ctx.session?.hook === "function") {
        await ctx.session.hook("context", async (event) => {
          if (!Array.isArray(event?.system)) return;
          event.system.push({type: "text", text: HOST_IDENTITY});
          event.system.push({type: "text", text: PLAN_PROTOCOL});
          // The directory's unarchived plans — skip the restricted helper
          // agents (single-step, deny-all: the note would be inert noise
          // in their focused prompts).
          if (typeof event.agent === "string" && event.agent.startsWith("lumina-")) return;
          try {
            const note = await activePlansNote(ctx, event.sessionID);
            if (note) event.system.push({type: "text", text: note});
          } catch {
            // best-effort context enrichment — never block the call
          }
        });
      }
    } catch {
      // Registration failed (shape drift on some server build) — the
      // tools still work; only the always-on prompt nudge is lost.
    }
  },
};
