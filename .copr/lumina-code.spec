# Composed Lumina Code COPR spec.
#
# This file is a TEMPLATE rendered by .github/workflows/copr.yml before an
# SRPM is built and submitted to COPR. The ${VERSION} placeholder is
# substituted at release-publish time (see the render step in the workflow).
# Do NOT edit the rendered values by hand — regenerate via the workflow
# instead.
#
# Local sanity check (after substituting ${VERSION}):
#   VERSION=0.1.0 && envsubst '${VERSION}' < .copr/lumina-code.spec | rpmspec -P /dev/stdin
#
# This is a *binary repack* package — the RPM sibling of .aur/PKGBUILD's -bin
# approach. COPR cannot host prebuilt RPMs directly (every package is built
# on COPR's builders from an SRPM), so the SRPM carries the two upstream
# .rpm bundles from the GitHub release as sources, and %install unpacks the
# one matching the build arch into the buildroot. Nothing compiles on COPR's
# side, so each chroot build finishes in well under a minute.
#
# NOTE on the bundled OpenCode server: the upstream .rpm carries a
# self-contained sidecar binary under /usr/lib/Lumina.Code/ — a statically
# linked single-file executable that adds NO extra runtime Requires.

# The payload ships as-built: keep Fedora's build-root scripts from stripping
# or otherwise mangling the prebuilt ELF, and drop the empty debuginfo
# subpackage they would otherwise emit. SONAME deps (webkit2gtk-4.1, gtk-3)
# are still auto-derived from the ELF at package time.
%global debug_package %{nil}
%global __os_install_post %{nil}

Name:           lumina-code
Version:        ${VERSION}
Release:        1%{?dist}
Summary:        A Tauri + React desktop GUI for OpenCode, bundling its own pinned server binary

License:        MPL-2.0
URL:            https://github.com/iewnfod/lumina-code
Source0:        %{url}/releases/download/v%{version}/Lumina.Code-%{version}-1.x86_64.rpm
Source1:        %{url}/releases/download/v%{version}/Lumina.Code-%{version}-1.aarch64.rpm

# Repacking needs no toolchain — just cpio to receive rpm2cpio's stream.
BuildRequires:  cpio
# The unpacked tree installs hicolor icons; the hicolor directory layout is
# owned by this package, not by every icon-carrying package.
Requires:       hicolor-icon-theme
# Only the arches the Release workflow publishes .rpm assets for. Any other
# chroot arch fails fast here instead of dying in %files with "no files".
ExclusiveArch:  x86_64 aarch64

%description
A Tauri + React desktop GUI for OpenCode, bundling its own pinned OpenCode
server binary — configuration, credentials, and sessions live under
~/.config/opencode / ~/.local/share/opencode, shared with any opencode you
run yourself.

This package repacks the official upstream binary release; the full release
history lives at %{url}/releases.

%prep

%build

%install
mkdir -p %{buildroot}
cd %{buildroot}
# rpm2cpio + cpio unpack the upstream .rpm's whole file tree — already laid
# out as /usr/{bin,lib,share} — straight into the buildroot. Upstream path
# components contain spaces ("Lumina Code"), so %files below matches
# everything with globs, never literal names.
%ifarch x86_64
rpm2cpio %{SOURCE0} | cpio -idm --quiet
%endif
%ifarch aarch64
rpm2cpio %{SOURCE1} | cpio -idm --quiet
%endif

%files
%{_bindir}/lumina-code
# Tauri's bundler places resources under plain /usr/lib on every arch —
# never rpm's libdir (lib64 on 64-bit Fedora) — so glob the prefix path.
# The bundled OpenCode sidecar rides under the same /usr/lib/Lumina.Code/
# tree.
%{_prefix}/lib/Lumina*
%{_datadir}/applications/Lumina*.desktop
%{_datadir}/icons/hicolor/*/apps/lumina-code.png
