import test from "node:test";
import assert from "node:assert/strict";

/**
 * The pure halves of the MCP log reader — shell-dialect-safe command
 * construction (no expansion, absolute paths — the login shell may be
 * fish, which rejects POSIX assignments/fallback expansions), the
 * data-dir probe parse, and output parsing. The api-bound halves stay
 * untested here (they only sequence spawnShell/awaitShell, the
 * worktreeSync.ts pattern).
 */
const {mcpLogCommand, mcpLogFile, parseMcpLogLines, parseShellProbe, shellProbeCommand, MCP_LOG_LINES} =
    await import("./mcpLogs.ts");

const LOG = "/home/user/.local/share/opencode/log/opencode.log";

test("posix command greps the server= needle against an absolute path", () => {
    const command = mcpLogCommand("pencil", "posix", LOG);
    assert.equal(
        command,
        `grep -F -s 'server=pencil' -- '${LOG}' | tail -n ${MCP_LOG_LINES}`,
    );
    // No shell assignments or fallback expansions anywhere — fish-safe.
    assert.ok(!command.includes("${"));
    assert.ok(!/\b\w+=/.test(command.replace(/server=pencil/, "").replace(/tail -n/, "")));
});

test("posix quoting survives a server name with a single quote", () => {
    const command = mcpLogCommand("it's", "posix", LOG);
    assert.ok(command.includes(`grep -F -s 'server=it'\\''s' --`));
});

test("powershell command selects the needle against an absolute path", () => {
    const command = mcpLogCommand("pencil", "powershell", LOG);
    assert.ok(command.includes(`if (Test-Path '${LOG}')`));
    assert.ok(command.includes(`Select-String -SimpleMatch 'server=pencil'`));
    assert.ok(command.includes(`Select-Object -Last ${MCP_LOG_LINES}`));
    assert.ok(command.endsWith("else { exit 1 }"));
});

test("powershell quoting doubles single quotes", () => {
    const command = mcpLogCommand("it's", "powershell", LOG);
    assert.ok(command.includes("Select-String -SimpleMatch 'server=it''s'"));
});

test("the probe command is dialect-neutral", () => {
    // Bare $VAR expansion + `;` only — valid in fish, POSIX sh and
    // PowerShell alike.
    assert.equal(shellProbeCommand(), "echo $XDG_DATA_HOME; echo $HOME");
});

test("parseShellProbe prefers XDG_DATA_HOME, falls back to HOME", () => {
    assert.equal(parseShellProbe("/custom/data\n/home/user\n"), "/custom/data");
    assert.equal(parseShellProbe("\n/home/user\n"), "/home/user/.local/share");
    assert.equal(parseShellProbe("\n\n"), null);
});

test("mcpLogFile joins and trims trailing slashes", () => {
    assert.equal(mcpLogFile("/home/user/.local/share"), LOG);
    assert.equal(mcpLogFile("/home/user/.local/share//"), LOG);
});

test("parseMcpLogLines lifts the structured prefix and keeps the rest verbatim", () => {
    const output = [
        'timestamp=2026-10-20T05:38:19.279Z level=INFO run=c927 message="mcp connected" server=pencil tools=5',
        'timestamp=2026-10-20T05:40:01.100Z level=WARN message="mcp connect failed" server=pencil status=failed',
        "",
        "some unstructured shell noise",
    ].join("\n");
    const lines = parseMcpLogLines(output);
    assert.deepEqual(lines, [
        {
            timestamp: "2026-10-20T05:38:19.279Z",
            level: "INFO",
            text: 'run=c927 message="mcp connected" server=pencil tools=5',
        },
        {
            timestamp: "2026-10-20T05:40:01.100Z",
            level: "WARN",
            text: 'message="mcp connect failed" server=pencil status=failed',
        },
        {text: "some unstructured shell noise"},
    ]);
});

test("parseMcpLogLines tolerates empty output", () => {
    assert.deepEqual(parseMcpLogLines(""), []);
    assert.deepEqual(parseMcpLogLines("\n \n"), []);
});
