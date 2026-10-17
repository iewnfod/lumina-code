#!/usr/bin/env node
// Fetches the pinned frpc binary (frp client) into src-tauri/binaries/ under
// a stable per-platform name (`frpc` / `frpc.exe`), referenced by the
// `resources` maps in tauri.linux/macos/windows.conf.json — the same
// resource-sidecar doctrine as fetch-opencode.mjs (private dir, never on the
// user's PATH). frps is NOT shipped: it runs on the lumina-server host as a
// container (server/deploy/frps.toml + docker-compose.yml), pinned there by
// the compose image tag.
//
// Downloads come from GitHub releases, verified against the release's
// frp_sha256_checksums.txt. GitHub direct downloads stall on some networks
// (observed during the migration spike), so the URL is tried direct first,
// then through known prefix mirrors; FRP_MIRROR pins one explicitly:
//
//   FRP_MIRROR=https://ghfast.top/ pnpm fetch:frp
//
// Usage (mirrors fetch-opencode.mjs):
//   pnpm fetch:frp            # host platform only
//   pnpm fetch:frp --all      # every target (CI release matrix)
//   pnpm fetch:frp <triple>…  # explicit Rust target triples
//
// FRP_VERSION must stay in sync with the frps image tag in
// docker-compose.yml (the frpc↔frps pair should never drift across
// minor versions).
const FRP_VERSION = "0.71.1";

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// LUMINA_BINARIES_DIR redirects the output (the CEF shell's binaries/).
const BINARIES_DIR = process.env.LUMINA_BINARIES_DIR
  ? join(REPO_ROOT, process.env.LUMINA_BINARIES_DIR)
  : join(REPO_ROOT, "src-tauri", "binaries");

// Rust target triple → frp release archive os/arch segment.
const TRIPLE_TO_TARGET = {
  "x86_64-unknown-linux-gnu": "linux_amd64",
  "aarch64-unknown-linux-gnu": "linux_arm64",
  "x86_64-apple-darwin": "darwin_amd64",
  "aarch64-apple-darwin": "darwin_arm64",
  "x86_64-pc-windows-msvc": "windows_amd64",
};

// Prefix mirrors tried in order when GitHub itself stalls. Each one is
// PREPENDED to the full GitHub URL (pass-through proxies). FRP_MIRROR (if
// set) replaces the whole chain, e.g. FRP_MIRROR=https://ghfast.top/
const MIRRORS = [
  "",
  "https://ghfast.top/",
  "https://gh-proxy.com/",
];

function hostTriple() {
  const platform = { linux: "unknown-linux-gnu", darwin: "apple-darwin", win32: "pc-windows-msvc" }[process.platform];
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  return platform && arch ? `${arch}-${platform}` : null;
}

function parseArgs(argv) {
  const triples = [];
  let all = false;
  for (const arg of argv) {
    if (arg === "--all") all = true;
    else if (!TRIPLE_TO_TARGET[arg]) {
      console.error(`unknown target triple ${arg} (known: ${Object.keys(TRIPLE_TO_TARGET).join(", ")})`);
      process.exit(1);
    } else triples.push(arg);
  }
  if (all) return Object.keys(TRIPLE_TO_TARGET);
  if (triples.length > 0) return triples;
  const host = hostTriple();
  if (!host) {
    console.error(`unsupported host platform ${process.platform}/${process.arch}; pass explicit triples`);
    process.exit(1);
  }
  return [host];
}

const RELEASE_BASE = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}`;

function mirrorChain() {
  if (process.env.FRP_MIRROR !== undefined) {
    return process.env.FRP_MIRROR === "" ? [""] : [process.env.FRP_MIRROR];
  }
  return MIRRORS;
}

/** fetch with a stall timeout — a hung direct connection must fall through
 * to the next mirror instead of hanging the script. */
async function fetchWithTimeout(url, ms = 45_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchThroughMirrors(path) {
  const errors = [];
  for (const prefix of mirrorChain()) {
    const url = `${prefix}${RELEASE_BASE}/${path}`;
    try {
      const res = await fetchWithTimeout(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      errors.push(`${res.status} ${url}`);
    } catch (e) {
      errors.push(`${e} ${url}`);
    }
  }
  throw new Error(`all download routes failed for ${path}:\n  ${errors.join("\n  ")}`);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchOne(triple) {
  const target = TRIPLE_TO_TARGET[triple];
  const isWindows = triple.endsWith("pc-windows-msvc");
  const exeSuffix = isWindows ? ".exe" : "";
  const archive = `frp_${FRP_VERSION}_${target}.tar.gz`;

  console.log(`→ frp v${FRP_VERSION} ${target} (${triple})`);
  const checksums = (await fetchThroughMirrors("frp_sha256_checksums.txt")).toString("utf8");
  const expected = checksums
    .split("\n")
    .find((line) => line.trim().endsWith(`  ${archive}`))
    ?.trim()
    .split(/\s+/)[0];
  if (!expected) throw new Error(`${archive} missing from frp_sha256_checksums.txt`);

  const body = await fetchThroughMirrors(archive);
  const actual = sha256(body);
  if (actual !== expected) throw new Error(`sha256 mismatch for ${archive}`);
  console.log(`  verified sha256, ${(body.length / 1e6).toFixed(1)} MB`);

  const tmp = await mkdtemp(join(tmpdir(), "frp-sidecar-"));
  try {
    const tgz = join(tmp, "frp.tar.gz");
    await writeFile(tgz, body);
    execFileSync("tar", ["-xzf", tgz, "-C", tmp], { stdio: "ignore" });
    const dir = join(tmp, `frp_${FRP_VERSION}_${target}`);
    const extracted = (await readdir(dir)).find((f) => f === `frpc${exeSuffix}`);
    if (!extracted) throw new Error(`archive for ${target} has no frpc${exeSuffix}`);

    await mkdir(BINARIES_DIR, { recursive: true });
    const dest = join(BINARIES_DIR, `frpc${exeSuffix}`);
    await rm(dest, { force: true });
    await copyFile(join(dir, extracted), dest);
    if (!isWindows) await chmod(dest, 0o755);
    console.log(`  → ${dest}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const triples = parseArgs(process.argv.slice(2));
if (triples.length > 1) {
  console.warn(
    `warning: ${triples.length} targets requested; they share one stable sidecar filename, so the LAST target wins (CI passes exactly one triple per job)`
  );
}
for (const triple of triples) {
  await fetchOne(triple);
}
