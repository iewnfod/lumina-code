/**
 * Pure extraction of a readable transcript from a synced ChatMessage[]
 * snapshot — the minimal admin/session view (the desktop owns the rich
 * renderer). Shapes mirror the desktop's `src/opencode/types.ts` (the
 * wire truth, verified against server v2.0.x):
 *
 *  - user messages carry `text`;
 *  - assistant messages carry `content: [{type:"text"|"reasoning"|"tool"}]`
 *    — text joins the body, tool parts become markers with their status,
 *    reasoning is skipped (verbose, rarely useful in a browse view);
 *  - marker messages (idle/system/…) are skipped entirely.
 */
export interface TranscriptToolCall {
  name: string;
  status: string;
}

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  tools: TranscriptToolCall[];
}

export function extractTranscript(messages: unknown): TranscriptEntry[] {
  if (!Array.isArray(messages)) return [];
  const entries: TranscriptEntry[] = [];
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as {type?: unknown; text?: unknown; content?: unknown};
    if (m.type === "user") {
      entries.push({role: "user", text: String(m.text ?? ""), tools: []});
    } else if (m.type === "assistant") {
      const tools: TranscriptToolCall[] = [];
      const texts: string[] = [];
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part !== "object" || part === null) continue;
          const p = part as {
            type?: unknown;
            text?: unknown;
            name?: unknown;
            state?: {status?: unknown} | null;
          };
          if (p.type === "text" && typeof p.text === "string") {
            texts.push(p.text);
          } else if (p.type === "tool") {
            tools.push({
              name: String(p.name ?? "tool"),
              status: String(p.state?.status ?? "unknown"),
            });
          }
          // "reasoning" intentionally skipped.
        }
      }
      entries.push({role: "assistant", text: texts.join("\n\n"), tools});
    }
  }
  return entries;
}
