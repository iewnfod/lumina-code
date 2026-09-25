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
//   - a plain-object default export loads (no @opencode/plugin import),
//   - ctx.tool.transform's editor.add works; ctx.session.{create, prompt,
//     wait, context, interrupt, switchAgent} exist,
//   - tool executors receive context.{sessionID, agent, signal} — the
//     CURRENT step's session and agent (schema/src/tool.ts at the tag;
//     switchAgent's REST twin verified live via /openapi.json),
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
  "Never claim progress you have not made. (3) Skip all of this for single-step answers and trivial edits.";

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
        // Route A approval gate: v2.0.11 has NO execution-time permission
        // check for plugin tools (binary-verified: options.permission only
        // filters tool visibility; asking is builtin-internal), so the
        // executor itself blocks until the user decides. Approval ARRIVES
        // as the agent switch (Lumina Code's approval card calls
        // switchAgent "build" — the gate opening IS the approval);
        // rejection arrives as this executor's abort signal (the card
        // interrupts the session).
        const sessionID = context.sessionID;
        const deadline = Date.now() + PLAN_APPROVAL_TIMEOUT_MS;
        let agent = "plan";
        try {
          for (;;) {
            if (context.signal?.aborted) break;
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
        return {
          content:
            "Plan approved — the user opened the gate and this session now runs in build mode. Execute the " +
            "tasks strictly in order; after finishing each, call task_complete with its EXACT title. Task list:\n" +
            renderChecklist(state),
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
                ? "Task completed — ALL tasks settled. Plan finished."
                : "Task completed.";
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
        const normalized = todos.map(normalizeTitle);
        if (new Set(normalized).size !== normalized.length) {
          return {error: "task titles must be unique"};
        }
        const history = state.items.filter((i) => i.status !== "pending");
        const next = {
          title: state.title,
          items: [...history, ...normalized.map((t) => ({title: t, status: "pending"}))],
        };
        return {
          content:
            (normalized.length === 0
              ? "Remaining tasks withdrawn — plan finished. Settled history:\n"
              : "Plan amended. The next task_complete must match the first open task. Task list:\n") +
            renderChecklist(next),
        };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/** The resident tools. Order matters only for tool-list presentation. */
const TOOLS = [vision, planMode, planSubmit, taskComplete, planAmend];

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
    // The plan-workflow protocol rides the "context" session hook when
    // the server offers it (v2.0.11 does — binary-verified; the docs'
    // event.system.push shape). Absent the hook, enforcement degrades
    // to the tool descriptions above.
    try {
      if (typeof ctx.session?.hook === "function") {
        await ctx.session.hook("context", (event) => {
          if (Array.isArray(event?.system)) {
            event.system.push({type: "text", text: PLAN_PROTOCOL});
          }
        });
      }
    } catch {
      // Registration failed (shape drift on some server build) — the
      // tools still work; only the always-on prompt nudge is lost.
    }
  },
};
