#!/usr/bin/env bash
#
# bump-version.sh — bump the Lumina Code version everywhere it must stay in
# sync: src-tauri/Cargo.toml, package.json, src-tauri/tauri.conf.json, and
# src-tauri/Cargo.lock. The lock is synced by running `cargo metadata` after
# the edits (a plain edit never touches the lock); `pnpm test` gates the bump
# on a green test suite.
#
# Ported from lumina-terminal/scripts/bump-version.sh — keep the two in sync.
# Differences from the sibling: tauri.conf.json uses 2-space indentation here
# (4-space there), and this repo has no Rust test suite / its cargo build
# needs the frontend dist + sidecar, so the gate is pnpm test and the lock
# sync is cargo metadata (which never compiles).
#
# Usage:
#   ./scripts/bump-version.sh <new-version>      # e.g. ./scripts/bump-version.sh 0.1.1
#   ./scripts/bump-version.sh --show             # print the current version
#   ./scripts/bump-version.sh --check            # exit non-zero if the three disagree
#
# The version has no leading "v" (that's a git-tag convention).

set -euo pipefail

PKG_JSON="package.json"
CARGO_TOML="src-tauri/Cargo.toml"
TAURI_CONF="src-tauri/tauri.conf.json"
CARGO_LOCK="src-tauri/Cargo.lock"
CARGO_PKG_NAME="lumina-code"

# Resolve repo root so the script works from any subdirectory.
root="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
PKG_JSON="$root/$PKG_JSON"
CARGO_TOML="$root/$CARGO_TOML"
TAURI_CONF="$root/$TAURI_CONF"
CARGO_LOCK="$root/$CARGO_LOCK"

# ---- color helpers (tty only) ----------------------------------------------
if [[ -t 1 ]]; then
	C_RESET=$'\033[0m'; BOLD=$'\033[1m'
	C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_CYAN=$'\033[36m'; C_YELLOW=$'\033[33m'
else
	C_RESET=""; BOLD=""; C_RED=""; C_GREEN=""; C_CYAN=""; C_YELLOW=""
fi
log()  { printf "%s▸%s %s\n" "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf "%s✓%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
die()  { printf "%s✗%s %s%s%s\n" "$C_RED" "$C_RESET" "$C_RED" "$*" "$C_RESET" 1>&2; exit 1; }

# ---- version readers --------------------------------------------------------
# Each file has a unique version-line shape; match it precisely so unrelated
# occurrences (deps, plugins) are never touched.
read_pkg_version()   { sed -n 's/^  "version": "\(.*\)",$/\1/p'         "$PKG_JSON"   | head -n1; }
read_cargo_version() { sed -n 's/^version = "\(.*\)"$/\1/p'             "$CARGO_TOML" | head -n1; }
read_tauri_version() { sed -n 's/^  "version": "\(.*\)",$/\1/p'         "$TAURI_CONF" | head -n1; }
# The lock lists every crate as a [[package]] stanza: name line, then version.
read_lock_version()  { sed -n "/^name = \"$CARGO_PKG_NAME\"\$/{n;s/^version = \"\\(.*\\)\"\$/\\1/p;}" "$CARGO_LOCK"; }

current_version() {
	local v_pkg v_cargo v_tauri
	v_pkg="$(read_pkg_version)"
	v_cargo="$(read_cargo_version)"
	v_tauri="$(read_tauri_version)"
	if [[ -z "$v_pkg" || -z "$v_cargo" || -z "$v_tauri" ]]; then
		die "Could not read version from all three files:"
		[[ -z "$v_pkg"   ]] && echo "  $PKG_JSON   (not found)" 1>&2
		[[ -z "$v_cargo" ]] && echo "  $CARGO_TOML (not found)" 1>&2
		[[ -z "$v_tauri" ]] && echo "  $TAURI_CONF (not found)" 1>&2
	fi
	if [[ "$v_pkg" != "$v_cargo" || "$v_pkg" != "$v_tauri" ]]; then
		die "Version mismatch across files:
  package.json             : $v_pkg
  src-tauri/Cargo.toml     : $v_cargo
  src-tauri/tauri.conf.json: $v_tauri
Fix them to agree first."
	fi
	echo "$v_pkg"
}

# Validate a version looks like dotted numbers, optionally with a pre-release
# suffix (e.g. 0.1.1, 1.2.3, 0.2.0-rc1, 0.1.1-fix).
valid_version() {
	[[ "$1" =~ ^[0-9]+(\.[0-9]+){1,3}(-[A-Za-z0-9._]+)?$ ]]
}

usage() {
	cat <<EOF
${BOLD}Usage:${C_RESET} bump-version.sh <new-version>
       bump-version.sh --show
       bump-version.sh --check

Bump the version in ${BOLD}package.json${C_RESET}, ${BOLD}src-tauri/Cargo.toml${C_RESET},
and ${BOLD}src-tauri/tauri.conf.json${C_RESET} in one shot (they must stay in sync).

Examples:
  ./scripts/bump-version.sh 0.1.1
  ./scripts/bump-version.sh 1.0.0-rc1
  ./scripts/bump-version.sh --show     # print current version
  ./scripts/bump-version.sh --check    # verify the three files agree
EOF
}

# ---- main -------------------------------------------------------------------
case "${1:-}" in
	"") die "Missing version argument. Run: bump-version.sh --help";;
	-h|--help) usage; exit 0;;
	--show) current_version; exit 0;;
	--check)
		cur="$(current_version)"
		v_lock="$(read_lock_version)"
		[[ -n "$v_lock" && "$v_lock" == "$cur" ]] \
			|| die "Cargo.lock reports '${v_lock:-not found}' but the manifest files report '$cur'.
Re-run the bump — cargo metadata re-syncs the lock."
		ok "All four files agree: $cur"; exit 0;;
esac

new="$1"
valid_version "$new" || die "Invalid version '$new'. Expected e.g. 0.1.1 or 1.0.0-rc1."
[[ "$new" != v* ]] || die "Drop the leading 'v' — use '${new#v}' (the 'v' is a git-tag convention)."

cur="$(current_version)"
[[ "$new" != "$cur" ]] || die "Version is already $cur — nothing to do."

log "Bumping version: ${BOLD}$cur${C_RESET} → ${BOLD}$new${C_RESET}"

# In-place edits. Each sed pattern matches exactly one line; locking onto the
# precise indentation/format avoids touching dependency versions. package.json
# and tauri.conf.json both use 2-space indentation in this repo — the reader
# functions disambiguate by file, and each file holds exactly one such line.
sed -i "s/^\\(  \"version\": \"\\).*\\(\",\\)$/\\1$new\\2/" "$PKG_JSON"
sed -i "s/^\\(version = \"\\).*\\(\"\\)$/\\1$new\\2/"      "$CARGO_TOML"
sed -i "s/^\\(  \"version\": \"\\).*\\(\",\\)$/\\1$new\\2/" "$TAURI_CONF"

# Re-read to confirm all three now report the new value.
v_pkg="$(read_pkg_version)"; v_cargo="$(read_cargo_version)"; v_tauri="$(read_tauri_version)"
[[ "$v_pkg" == "$new" && "$v_cargo" == "$new" && "$v_tauri" == "$new" ]] \
	|| die "Verification failed — please check the three files manually:
  package.json             : $v_pkg
  src-tauri/Cargo.toml     : $v_cargo
  src-tauri/tauri.conf.json: $v_tauri"

# Re-resolve the lock WITHOUT building (this crate's cargo build needs the
# frontend dist + sidecar; plain metadata resolves the graph — updating the
# lock for this crate's new version — and never bumps deps beyond what the
# manifests already require; --no-deps would SKIP resolution and not touch it).
command -v cargo >/dev/null 2>&1 \
	|| die "cargo not found — cannot sync Cargo.lock. Install Rust, or edit the lock by hand."
log "Syncing Cargo.lock (cargo metadata)..."
cargo metadata --format-version 1 --manifest-path "$root/src-tauri/Cargo.toml" \
	> /dev/null \
	|| die "cargo metadata failed — the lock was not synced."

v_lock="$(read_lock_version)"
if [[ "$v_lock" != "$new" ]]; then
	# Fallback resolver in case a future cargo stops touching the lock from
	# metadata alone: cargo tree re-resolves the graph and rewrites it.
	log "metadata did not update the lock, retrying with cargo tree..."
	cargo tree --workspace --edges no-dev,no-build \
		--manifest-path "$root/src-tauri/Cargo.toml" > /dev/null \
		|| die "cargo tree failed — the lock was not synced."
	v_lock="$(read_lock_version)"
fi
[[ "$v_lock" == "$new" ]] \
	|| die "Cargo.lock still reports '${v_lock:-not found}' — expected '$new'."

# Frontend gate: this repo's test suite is pure-frontend (node --test).
log "Running pnpm test (gates the bump)..."
( cd "$root" && pnpm test ) || die "pnpm test failed — the bump is not ready to release."

ok "Updated version to ${BOLD}$new${C_RESET} in:"
echo "  package.json"
echo "  src-tauri/Cargo.toml"
echo "  src-tauri/tauri.conf.json"
echo "  src-tauri/Cargo.lock (via cargo metadata)"
echo
log "Next: commit, tag, and publish a release (the Release workflow attaches assets on publish):"
printf "  git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock\n"
printf "  git commit -m \"update: v%s\"\n  git tag v%s\n  git push origin master v%s\n" "$new" "$new" "$new"
printf "  gh release create v%s --title \"Lumina Code v%s\" --notes-file <notes>\n" "$new" "$new"
