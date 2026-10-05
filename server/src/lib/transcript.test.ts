import {describe, expect, it} from "vitest";

import {extractTranscript} from "./transcript.ts";

const sample = [
  {id: "msg_1", type: "user", text: "帮我看看这个报错"},
  {
    id: "msg_2",
    type: "assistant",
    content: [
      {type: "reasoning", text: "thinking..."},
      {type: "text", text: "我先读一下文件。"},
      {type: "tool", id: "tool_1", name: "read", state: {status: "completed"}},
    ],
  },
  {id: "msg_3", type: "idle", time: {created: 1}},
  {
    id: "msg_4",
    type: "assistant",
    content: [
      {type: "tool", id: "tool_2", name: "edit", state: {status: "running"}},
      {type: "text", text: "改好了。"},
    ],
  },
];

describe("extractTranscript", () => {
  it("walks users, assistant text and tool markers; skips reasoning/markers", () => {
    const entries = extractTranscript(sample);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({role: "user", text: "帮我看看这个报错", tools: []});
    expect(entries[1]).toEqual({
      role: "assistant",
      text: "我先读一下文件。",
      tools: [{name: "read", status: "completed"}],
    });
    expect(entries[2].tools).toEqual([{name: "edit", status: "running"}]);
    expect(entries[2].text).toBe("改好了。");
  });

  it("tolerates garbage", () => {
    expect(extractTranscript(null)).toEqual([]);
    expect(extractTranscript("nope")).toEqual([]);
    expect(extractTranscript([1, null, {type: "idle"}, {type: "user"}])).toEqual([
      {role: "user", text: "", tools: []},
    ]);
  });
});
