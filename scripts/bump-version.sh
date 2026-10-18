#!/usr/bin/env bash
#
# bump-version.sh — bump the Lumina Code version everywhere it must stay in
# sync. The app releases THREE build units together from one tag (the webkit
# shell at the repo root, the CEF/Chromium shell under cef/, and the mobile
# app under mobile/), so the bump covers BOTH quartets AND the mobile trio:
# package.json + src-tauri/{Cargo.toml, tauri.conf.json}, their
# cef/package.json + cef/src-tauri/{...} counterparts, and
# mobile/src-tauri/{Cargo.toml, tauri.conf.json} — the mobile app shares the
# repo-root package.json (its frontend is the second vite entry), so it has
# NO package.json of its own: a trio, not a quartet. Each Cargo.lock is
# synced by running `cargo metadata` against its own manifest (a plain edit
# never touches the lock); `pnpm test` gates the bump on a green test suite.
#
# Ported from lumina-terminal/scripts/bump-version.sh — keep the two in sync.
# Differences from the sibling: tauri.conf.json uses 2-space indentation here
# (4-space there), and this repo has no Rust test suite / its cargo build
# needs the frontend dist + sidecar, so the gate is pnpm test and the lock
# sync is cargo metadata (which never compiles). The entire CEF quartet and
# mobile trio are lumina-code-only additions — the sibling has no second
# shell. The mobile version also feeds Android's versionName/versionCode at
# build time (tauri.android.versionCode = major*1000000 + minor*1000 +
# patch, derived from tauri.conf.json — nothing to hand-edit under gen/).
#
# Usage:
#   ./scripts/bump-version.sh <new-version>      # e.g. ./scripts/bump-version.sh 0.1.1
#   ./scripts/bump-version.sh --show             # print the current version
#   ./scripts/bump-version.sh --check            # exit non-zero if any file disagrees
#
# The version has no leading "v" (that's a git-tag convention).

set -euo pipefail

PKG_JSON="package.json"
CARGO_TOML="src-tauri/Cargo.toml"
TAURI_CONF="src-tauri/tauri.conf.json"
CARGO_LOCK="src-tauri/Cargo.lock"
CEF_PKG_JSON="cef/package.json"
CEF_CARGO_TOML="cef/src-tauri/Cargo.toml"
CEF_TAURI_CONF="cef/src-tauri/tauri.conf.json"
CEF_CARGO_LOCK="cef/src-tauri/Cargo.lock"
MOBILE_CARGO_TOML="mobile/src-tauri/Cargo.toml"
MOBILE_TAURI_CONF="mobile/src-tauri/tauri.conf.json"
MOBILE_CARGO_LOCK="mobile/src-tauri/Cargo.lock"
CARGO_PKG_NAME="lumina-code"
CARGO_PKG_NAME_CEF="lumina-code-cef"
CARGO_PKG_NAME_MOBILE="lumina-code-mobile"

# Resolve repo root so the script works from any subdirectory.
root="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
PKG_JSON="$root/$PKG_JSON"
CARGO_TOML="$root/$CARGO_TOML"
TAURI_CONF="$root/$TAURI_CONF"
CARGO_LOCK="$root/$CARGO_LOCK"
CEF_PKG_JSON="$root/$CEF_PKG_JSON"
CEF_CARGO_TOML="$root/$CEF_CARGO_TOML"
CEF_TAURI_CONF="$root/$CEF_TAURI_CONF"
CEF_CARGO_LOCK="$root/$CEF_CARGO_LOCK"
MOBILE_CARGO_TOML="$root/$MOBILE_CARGO_TOML"
MOBILE_TAURI_CONF="$root/$MOBILE_TAURI_CONF"
MOBILE_CARGO_LOCK="$root/$MOBILE_CARGO_LOCK"

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
# Parameterized by file path ($1) so the webkit and CEF shells share them —
# each counterpart file has the byte-identical version-line shape. Match it
# precisely so unrelated occurrences (deps, plugins) are never touched.
read_pkg_version()   { sed -n 's/^  "version": "\(.*\)",$/\1/p' "$1" | head -n1; }
read_cargo_version() { sed -n 's/^version = "\(.*\)"$/\1/p'     "$1" | head -n1; }
read_tauri_version() { sed -n 's/^  "version": "\(.*\)",$/\1/p' "$1" | head -n1; }
# The lock ($1) lists every crate as a [[package]] stanza: name line ($2),
# then version.
read_lock_version()  { sed -n "/^name = \"$2\"\$/{n;s/^version = \"\\(.*\\)\"\$/\\1/p;}" "$1"; }

# ---- version writers --------------------------------------------------------
# Same parameterization on the write side; each pattern matches exactly one
# line per file, locking onto the precise indentation/format so dependency
# versions are never touched. The JSON files all use 2-space indentation in
# this repo — the reader functions disambiguate by shape, and each file holds
# exactly one such line.
set_json_version()   { sed -i "s/^\\(  \"version\": \"\\).*\\(\",\\)$/\\1$2\\2/" "$1"; }
set_cargo_version()  { sed -i "s/^\\(version = \"\\).*\\(\"\\)$/\\1$2\\2/" "$1"; }

# The main (webkit) shell's trio is the source of truth: they must agree
# among themselves before anything else makes sense. The CEF shell is
# deliberately NOT checked here — it lagging behind is exactly the drift a
# bump run repairs (see the union-aware early exit below).
current_version() {
	local v_pkg v_cargo v_tauri
	v_pkg="$(read_pkg_version "$PKG_JSON")"
	v_cargo="$(read_cargo_version "$CARGO_TOML")"
	v_tauri="$(read_tauri_version "$TAURI_CONF")"
	if [[ -z "$v_pkg" || -z "$v_cargo" || -z "$v_tauri" ]]; then
		# Print the per-file detail BEFORE dying — a die-then-echo pair would
		# never reach the echoes (die exits).
		{
			echo "Could not read version from all three files:"
			[[ -z "$v_pkg"   ]] && echo "  $PKG_JSON   (not found)" || true
			[[ -z "$v_cargo" ]] && echo "  $CARGO_TOML (not found)" || true
			[[ -z "$v_tauri" ]] && echo "  $TAURI_CONF (not found)" || true
		} 1>&2
		exit 1
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
${BOLD}src-tauri/tauri.conf.json${C_RESET}, the CEF shell's ${BOLD}cef/${C_RESET}
counterparts, and the mobile app's ${BOLD}mobile/src-tauri/${C_RESET} trio in
one shot (all three build units release from one tag — they must stay
in sync).

Examples:
  ./scripts/bump-version.sh 0.1.1
  ./scripts/bump-version.sh 1.0.0-rc1
  ./scripts/bump-version.sh --show     # print current version
  ./scripts/bump-version.sh --check    # verify all eleven files agree
EOF
}

# ---- main -------------------------------------------------------------------
case "${1:-}" in
	"") die "Missing version argument. Run: bump-version.sh --help";;
	-h|--help) usage; exit 0;;
	--show) current_version; exit 0;;
	--check)
		cur="$(current_version)"
		v_lock="$(read_lock_version "$CARGO_LOCK" "$CARGO_PKG_NAME")"
		v_cef_pkg="$(read_pkg_version "$CEF_PKG_JSON")"
		v_cef_cargo="$(read_cargo_version "$CEF_CARGO_TOML")"
		v_cef_tauri="$(read_tauri_version "$CEF_TAURI_CONF")"
		v_cef_lock="$(read_lock_version "$CEF_CARGO_LOCK" "$CARGO_PKG_NAME_CEF")"
		v_mobile_cargo="$(read_cargo_version "$MOBILE_CARGO_TOML")"
		v_mobile_tauri="$(read_tauri_version "$MOBILE_TAURI_CONF")"
		v_mobile_lock="$(read_lock_version "$MOBILE_CARGO_LOCK" "$CARGO_PKG_NAME_MOBILE")"
		if [[ "$v_lock" != "$cur" || "$v_cef_pkg" != "$cur" || "$v_cef_cargo" != "$cur" \
			|| "$v_cef_tauri" != "$cur" || "$v_cef_lock" != "$cur" \
			|| "$v_mobile_cargo" != "$cur" || "$v_mobile_tauri" != "$cur" \
			|| "$v_mobile_lock" != "$cur" ]]; then
			die "Version files disagree (all eleven must match):
  package.json                    : $(read_pkg_version "$PKG_JSON")
  src-tauri/Cargo.toml            : $(read_cargo_version "$CARGO_TOML")
  src-tauri/tauri.conf.json       : $(read_tauri_version "$TAURI_CONF")
  src-tauri/Cargo.lock            : ${v_lock:-not found}
  cef/package.json                : ${v_cef_pkg:-not found}
  cef/src-tauri/Cargo.toml        : ${v_cef_cargo:-not found}
  cef/src-tauri/tauri.conf.json   : ${v_cef_tauri:-not found}
  cef/src-tauri/Cargo.lock        : ${v_cef_lock:-not found}
  mobile/src-tauri/Cargo.toml     : ${v_mobile_cargo:-not found}
  mobile/src-tauri/tauri.conf.json: ${v_mobile_tauri:-not found}
  mobile/src-tauri/Cargo.lock     : ${v_mobile_lock:-not found}
Re-run the bump with '$cur' (or the next version) — it aligns all three
build units and cargo metadata re-syncs the locks."
		fi
		ok "All eleven files agree: $cur"; exit 0;;
esac

new="$1"
valid_version "$new" || die "Invalid version '$new'. Expected e.g. 0.1.1 or 1.0.0-rc1."
[[ "$new" != v* ]] || die "Drop the leading 'v' — use '${new#v}' (the 'v' is a git-tag convention)."

cur="$(current_version)"
v_cef_pkg="$(read_pkg_version "$CEF_PKG_JSON")"
v_cef_cargo="$(read_cargo_version "$CEF_CARGO_TOML")"
v_cef_tauri="$(read_tauri_version "$CEF_TAURI_CONF")"
v_lock="$(read_lock_version "$CARGO_LOCK" "$CARGO_PKG_NAME")"
v_cef_lock="$(read_lock_version "$CEF_CARGO_LOCK" "$CARGO_PKG_NAME_CEF")"
v_mobile_cargo="$(read_cargo_version "$MOBILE_CARGO_TOML")"
v_mobile_tauri="$(read_tauri_version "$MOBILE_TAURI_CONF")"
v_mobile_lock="$(read_lock_version "$MOBILE_CARGO_LOCK" "$CARGO_PKG_NAME_MOBILE")"

# Union-aware early exit: "nothing to do" only when EVERY file — all three
# build units' manifests AND all three locks — already sits at the target.
# The CEF or mobile unit (or a lock) lagging behind the main one (e.g. after
# a bump made before this script knew about cef/ or mobile/) is drift this
# very run repairs, not a reason to refuse.
if [[ "$new" == "$cur" && "$v_cef_pkg" == "$new" && "$v_cef_cargo" == "$new" && "$v_cef_tauri" == "$new" \
	&& "$v_lock" == "$new" && "$v_cef_lock" == "$new" \
	&& "$v_mobile_cargo" == "$new" && "$v_mobile_tauri" == "$new" && "$v_mobile_lock" == "$new" ]]; then
	die "Version is already $cur everywhere — nothing to do."
fi
if [[ "$new" == "$cur" ]]; then
	log "Repairing version drift → ${BOLD}$new${C_RESET} (main shell already at $cur)"
else
	log "Bumping version: ${BOLD}$cur${C_RESET} → ${BOLD}$new${C_RESET}"
fi

set_json_version  "$PKG_JSON"        "$new"
set_cargo_version "$CARGO_TOML"      "$new"
set_json_version  "$TAURI_CONF"      "$new"
set_json_version  "$CEF_PKG_JSON"    "$new"
set_cargo_version "$CEF_CARGO_TOML"  "$new"
set_json_version  "$CEF_TAURI_CONF"  "$new"
set_cargo_version "$MOBILE_CARGO_TOML" "$new"
set_json_version  "$MOBILE_TAURI_CONF" "$new"

# Re-read to confirm all eight manifest files now report the new value.
v_pkg="$(read_pkg_version "$PKG_JSON")"; v_cargo="$(read_cargo_version "$CARGO_TOML")"; v_tauri="$(read_tauri_version "$TAURI_CONF")"
v_cef_pkg="$(read_pkg_version "$CEF_PKG_JSON")"; v_cef_cargo="$(read_cargo_version "$CEF_CARGO_TOML")"; v_cef_tauri="$(read_tauri_version "$CEF_TAURI_CONF")"
v_mobile_cargo="$(read_cargo_version "$MOBILE_CARGO_TOML")"; v_mobile_tauri="$(read_tauri_version "$MOBILE_TAURI_CONF")"
[[ "$v_pkg" == "$new" && "$v_cargo" == "$new" && "$v_tauri" == "$new" \
	&& "$v_cef_pkg" == "$new" && "$v_cef_cargo" == "$new" && "$v_cef_tauri" == "$new" \
	&& "$v_mobile_cargo" == "$new" && "$v_mobile_tauri" == "$new" ]] \
	|| die "Verification failed — please check the files manually:
  package.json                    : $v_pkg
  src-tauri/Cargo.toml            : $v_cargo
  src-tauri/tauri.conf.json       : $v_tauri
  cef/package.json                : $v_cef_pkg
  cef/src-tauri/Cargo.toml        : $v_cef_cargo
  cef/src-tauri/tauri.conf.json   : $v_cef_tauri
  mobile/src-tauri/Cargo.toml     : $v_mobile_cargo
  mobile/src-tauri/tauri.conf.json: $v_mobile_tauri"

# Re-resolve each lock WITHOUT building (the crates' cargo build needs the
# frontend dist + sidecar; plain metadata resolves the graph — updating the
# lock for its crate's new version — and never bumps deps beyond what the
# manifests already require; --no-deps would SKIP resolution and not touch
# it). Runs once per build unit: the three crates have separate manifests
# and locks.
command -v cargo >/dev/null 2>&1 \
	|| die "cargo not found — cannot sync the Cargo.locks. Install Rust, or edit them by hand."
sync_lock() {
	local lock_label="$1" manifest="$2" lock="$3" crate="$4" v
	log "Syncing $lock_label (cargo metadata)..."
	cargo metadata --format-version 1 --manifest-path "$manifest" \
		> /dev/null \
		|| die "cargo metadata failed for $manifest — the lock was not synced."
	v="$(read_lock_version "$lock" "$crate")"
	if [[ "$v" != "$new" ]]; then
		# Fallback resolver in case a future cargo stops touching the lock from
		# metadata alone: cargo tree re-resolves the graph and rewrites it.
		log "metadata did not update $lock_label, retrying with cargo tree..."
		cargo tree --workspace --edges no-dev,no-build \
			--manifest-path "$manifest" > /dev/null \
			|| die "cargo tree failed for $manifest — the lock was not synced."
		v="$(read_lock_version "$lock" "$crate")"
	fi
	[[ "$v" == "$new" ]] \
		|| die "$lock_label still reports '${v:-not found}' — expected '$new'."
}
sync_lock "src-tauri/Cargo.lock"     "$root/src-tauri/Cargo.toml"     "$CARGO_LOCK"     "$CARGO_PKG_NAME"
sync_lock "cef/src-tauri/Cargo.lock" "$root/cef/src-tauri/Cargo.toml" "$CEF_CARGO_LOCK" "$CARGO_PKG_NAME_CEF"
sync_lock "mobile/src-tauri/Cargo.lock" "$root/mobile/src-tauri/Cargo.toml" "$MOBILE_CARGO_LOCK" "$CARGO_PKG_NAME_MOBILE"

# Frontend gate: this repo's test suite is pure-frontend (node --test).
log "Running pnpm test (gates the bump)..."
( cd "$root" && pnpm test ) || die "pnpm test failed — the bump is not ready to release."

ok "Updated version to ${BOLD}$new${C_RESET} in:"
echo "  package.json"
echo "  src-tauri/Cargo.toml"
echo "  src-tauri/tauri.conf.json"
echo "  src-tauri/Cargo.lock (via cargo metadata)"
echo "  cef/package.json"
echo "  cef/src-tauri/Cargo.toml"
echo "  cef/src-tauri/tauri.conf.json"
echo "  cef/src-tauri/Cargo.lock (via cargo metadata)"
echo "  mobile/src-tauri/Cargo.toml"
echo "  mobile/src-tauri/tauri.conf.json"
echo "  mobile/src-tauri/Cargo.lock (via cargo metadata)"
echo
log "Next: commit, tag, and publish a release (the Release workflow attaches assets on publish):"
printf "  git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock \\\\\n"
printf "      cef/package.json cef/src-tauri/Cargo.toml cef/src-tauri/tauri.conf.json cef/src-tauri/Cargo.lock \\\\\n"
printf "      mobile/src-tauri/Cargo.toml mobile/src-tauri/tauri.conf.json mobile/src-tauri/Cargo.lock\n"
printf "  git commit -m \"update: v%s\"\n  git tag v%s\n  git push origin master v%s\n" "$new" "$new" "$new"
printf "  gh release create v%s --title \"Lumina Code v%s\" --notes-file <notes>\n" "$new" "$new"
