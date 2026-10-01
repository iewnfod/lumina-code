# Composed Lumina Code CEF COPR spec.
#
# This file is a TEMPLATE rendered by .github/workflows/copr.yml before an
# SRPM is built and submitted to COPR. The ${VERSION} placeholder is
# substituted at release-publish time (see the render step in the workflow);
# ${TAG} becomes the release TAG verbatim (e.g. "v0.1.2-2"). Do NOT edit
# the rendered values by hand — regenerate via the workflow instead.
#
# This is the CEF (Chromium) rendering variant of the lumina-code package:
# same app and backend, but the webview is bundled Chromium (tauri v3 alpha
# line + tauri-runtime-cef) instead of the system WebKitGTK — read
# "experimental". It coexists with the lumina-code package (distinct
# identifier, binary lumina-code-cef and desktop entry).
#
# Like lumina-code.spec this is a *binary repack*: the SRPM carries the two
# upstream .rpm bundles from the GitHub release as sources, and %install
# unpacks the arch-matching one into the buildroot. Nothing compiles on
# COPR's side. The sidecar rides under /usr/lib/Lumina Code CEF/ and the
# Chromium runtime (libcef.so) ships inside the package as well.

# The payload ships as-built: keep Fedora's build-root scripts from stripping
# or otherwise mangling the prebuilt ELF (libcef.so included), and drop the
# empty debuginfo subpackage they would otherwise emit. SONAME deps (gtk4)
# are still auto-derived from the ELF at package time.
%global debug_package %{nil}
%global __os_install_post %{nil}

Name:           lumina-code-cef
Version:        ${VERSION}
Release:        1%{?dist}
Summary:        A Tauri + React desktop GUI for OpenCode — CEF (Chromium) rendering variant

License:        MPL-2.0
URL:            https://github.com/iewnfod/lumina-code
# The URL's tag segment is the rendered ${TAG}, NOT "v%{version}":
# republished releases carry a suffix in the tag (v0.1.2-2) while the assets
# stay named after the plain app version.
Source0:        %{url}/releases/download/${TAG}/Lumina.Code.CEF-%{version}-1.x86_64.rpm
Source1:        %{url}/releases/download/${TAG}/Lumina.Code.CEF-%{version}-1.aarch64.rpm

# Repacking needs no toolchain — just cpio to receive rpm2cpio's stream.
BuildRequires:  cpio
Requires:       hicolor-icon-theme
# Only the arches the Release workflow publishes .rpm assets for.
ExclusiveArch:  x86_64 aarch64

%description
A Tauri + React desktop GUI for OpenCode — CEF (Chromium) rendering variant,
bundling its own pinned OpenCode server binary and the Chromium runtime.

This is an experimental flavor riding on the tauri v3 alpha runtime line;
it can be installed alongside the standard lumina-code package.

This package repacks the official upstream binary release; the full release
history lives at %{url}/releases.

%prep

%build

%install
mkdir -p %{buildroot}
cd %{buildroot}
# rpm2cpio + cpio unpack the upstream .rpm's whole file tree — already laid
# out as /usr/{bin,lib,share} — straight into the buildroot. Upstream path
# components contain spaces ("Lumina Code CEF"), so %files below matches
# everything with globs, never literal names.
%ifarch x86_64
rpm2cpio %{SOURCE0} | cpio -idm --quiet
%endif
%ifarch aarch64
rpm2cpio %{SOURCE1} | cpio -idm --quiet
%endif

%files
%{_bindir}/lumina-code-cef
# Tauri's bundler places resources under plain /usr/lib on every arch —
# never rpm's libdir (lib64 on 64-bit Fedora) — so glob the prefix path.
# The bundled OpenCode sidecar AND the Chromium runtime (libcef.so) ride
# under the same /usr/lib/Lumina Code CEF/ tree.
%{_prefix}/lib/Lumina*
%{_datadir}/applications/Lumina*.desktop
%{_datadir}/icons/hicolor/*/apps/lumina-code*.png
