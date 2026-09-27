#!/usr/bin/env node
// Fetches the pinned OpenCode server binary into src-tauri/binaries/ under a
// stable per-platform name (`opencode` / `opencode.exe`), referenced by the
// `resources` maps in tauri.linux/macos/windows.conf.json. Shipping it as a
// resource (NOT externalBin) keeps it in the app's PRIVATE resource dir —
// /usr/lib/Lumina Code/ on Linux packages, Contents/Resources on macOS, the
// install dir on Windows — instead of next to the main executable, where
// deb/rpm would install it as /usr/bin/opencode and pollute the user's PATH.
//
// OpenCode v2 distributes its binaries as versioned npm packages
// (`@opencode/cli-<target>`; older releases under `@opencode-ai`), so the
// tarball comes from registry.npmjs.org and is verified against the
// registry's published `dist.integrity` (sha512) before extraction — no
// hand-maintained checksum list.
//
// Usage:
//   pnpm fetch:opencode            # host platform only
//   pnpm fetch:opencode --all      # every target (CI release matrix)
//   pnpm fetch:opencode <triple>…  # explicit Rust target triples
//
// OPENCODE_VERSION is the single source of truth for the bundled server.
// Keep it in sync with EXPECTED_OPENCODE_VERSION in src-tauri/src/opencode.rs
// (which enforces the pin at startup) and with the pinned @opencode-ai/sdk
// dependency in package.json.
const OPENCODE_VERSION = "2.0.11";

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BINARIES_DIR = join(REPO_ROOT, "src-tauri", "binaries");

// Rust target triple (the externalBin filename suffix) → npm package target.
const TRIPLE_TO_TARGET = {
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-pc-windows-msvc": "windows-x64",
};

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

async function fetchManifest(target, version) {
  // Current scope first; the legacy @opencode-ai scope hosts older releases.
  for (const scope of ["@opencode", "@opencode-ai"]) {
    const pkg = `${scope}/cli-${target}`;
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/${version}`;
    const res = await fetch(url);
    if (res.ok) return await res.json();
    if (res.status !== 404) throw new Error(`registry returned ${res.status} for ${url}`);
  }
  throw new Error(`no npm package publishes cli-${target}@${version}`);
}

async function downloadVerified(tarball, integrity) {
  const res = await fetch(tarball);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} for ${tarball}`);
  const body = Buffer.from(await res.arrayBuffer());
  const expected = integrity.replace(/^sha512-/, "");
  const actual = createHash("sha512").update(body).digest("base64");
  if (actual !== expected) throw new Error(`sha512 mismatch for ${tarball}`);
  return body;
}

async function fetchOne(triple) {
  const target = TRIPLE_TO_TARGET[triple];
  const isWindows = triple.endsWith("pc-windows-msvc");
  const exeSuffix = isWindows ? ".exe" : "";

  console.log(`→ cli-${target}@${OPENCODE_VERSION} (${triple})`);
  const manifest = await fetchManifest(target, OPENCODE_VERSION);
  const body = await downloadVerified(manifest.dist.tarball, manifest.dist.integrity);
  console.log(`  verified sha512, ${(body.length / 1e6).toFixed(1)} MB`);

  const tmp = await mkdtemp(join(tmpdir(), "opencode-sidecar-"));
  try {
    const tgz = join(tmp, "package.tgz");
    await writeFile(tgz, body);
    // System tar: present on Linux/macOS and Windows 10+ (bsdtar) alike.
    execFileSync("tar", ["-xzf", tgz, "-C", tmp], { stdio: "ignore" });
    const binDir = join(tmp, "package", "bin");
    const extracted = (await readdir(binDir)).find((f) => f === `opencode${exeSuffix}`);
    if (!extracted) throw new Error(`tarball for ${target} has no package/bin/opencode${exeSuffix}`);

    await mkdir(BINARIES_DIR, { recursive: true });
    // Stable (triple-less) name: the resources maps reference one fixed
    // filename per platform. The exec bit is preserved by the bundlers
    // (tauri-bundler copies resource modes from disk), so 0755 here means
    // 0755 inside the deb/rpm.
    const dest = join(BINARIES_DIR, `opencode${exeSuffix}`);
    // Clear the legacy externalBin layout (triple-suffixed name) so stale
    // files never masquerade as the current sidecar.
    await rm(join(BINARIES_DIR, `opencode-${triple}${exeSuffix}`), { force: true });
    await rm(dest, { force: true });
    // copyFile, not rename: the temp dir may live on another filesystem.
    await copyFile(join(binDir, extracted), dest);
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
