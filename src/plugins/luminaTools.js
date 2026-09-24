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
//         live; see components/settings/toolPluginConfig.ts, which owns
//         the config-side definition and keeps it in sync with the
//         plugin entry).
//     tool(options, ctx) → the definition handed to editor.add
//         (name / description / input schema / execute). Keep descriptions
//         written for the CALLING model — they are the model's only manual.
//   }
//
// v2.0.11 verified behaviors this file relies on:
//   - a plain-object default export loads (no @opencode/plugin import),
//   - ctx.tool.transform's editor.add works; ctx.session.{create, prompt,
//     wait, context, interrupt} exist,
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
        "Ask a vision-capable model about an image file and get its answer as text — your way to " +
        "'see' images (screenshots, photos, diagrams, charts). Use it whenever a question needs the " +
        "visual content of an image, e.g. a path the user's message notes as an attached image, or any " +
        "image file you find in the workspace. Pass a focused question; the tool returns the other " +
        "model's answer.",
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
// Host
// ---------------------------------------------------------------------------

/** The resident tools. Order matters only for tool-list presentation. */
const TOOLS = [vision];

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
  },
};
