//! Native window background blur via the `ext-background-effect-v1`
//! Wayland protocol (wayland-protocols staging). Mutter 51 (GNOME 51),
//! KWin 6.7+, COSMIC 1.11+ and niri implement it: the client requests
//! that the compositor blur the region behind its `wl_surface`, no
//! shell extension involved. This is the preferred blur path
//! everywhere it is advertised; the Blur my Shell dance (blur.rs)
//! remains the fallback for older GNOME.
//!
//! Protocol shape (verified against wayland-app/protocols and the
//! Mutter 51 MR):
//! - bind the `ext_background_effect_manager_v1` global → a
//!   `capabilities` event reports the `blur` bit (the only capability
//!   so far);
//! - `get_background_effect(surface)` creates ONE
//!   `ext_background_effect_surface_v1` per surface — creating a
//!   second one raises the `background_effect_exists` protocol error,
//!   so the effect object is created ONCE per surface generation and
//!   toggles NEVER destroy it: off is `set_blur_region(None)`, the
//!   protocol's official removal (and wayland-client's Proxy drop
//!   does not send the destructor request anyway — a drop→recreate
//!   cycle would raise background_effect_exists on the next create,
//!   live-verified as the Gdk "Error 71" crash);
//! - `set_blur_region(region)` — the INITIAL region is EMPTY, so a
//!   full-surface rect must be set explicitly (surface-local coords,
//!   clipped by the compositor; a big rect is safe). `NULL` removes
//!   the effect;
//! - the state is double-buffered and lands on the next
//!   `wl_surface.commit` — which must be GDK's OWN commit: committing
//!   a foreign surface races GDK's frame state machine and Mutter 51
//!   kills the connection with a protocol error (live-verified —
//!   Gdk "Error 71"). There is NO radius parameter: the blur
//!   strength follows compositor policy, so the frontend exposes no
//!   strength UI;
//! - once the `wl_surface` is destroyed the effect object goes inert.
//!
//! ## Why a hand-spoken protocol (GDK has no API for this)
//!
//! The webkit shell is GTK3 (tauri v2 / tao), and GTK3 will never gain
//! support for this protocol. So this module bridges to GDK's own
//! Wayland connection:
//!
//! - the `wl_surface` comes from tauri's `gtk_window()` +
//!   `WidgetExt::window()` (a `gdk::Window`);
//! - the GDK Wayland entry points are resolved with
//!   dlopen("libgdk-3.so.0") — ZERO link-time dependency. A link-time
//!   `extern "C"` would make the whole binary refuse to LOAD on a
//!   distro GTK3 built without the Wayland backend; dlopen degrades
//!   to "unavailable" instead. `gdk_display_get_name` confirms the
//!   backend is Wayland before any `gdk_wayland_*` call (calling
//!   those on an X11 display would be undefined behavior);
//! - the `wl_display` / `wl_surface` pointers are wrapped through
//!   wayland-client's system backend
//!   (`Backend::from_foreign_display` + `ObjectId::from_ptr`), with a
//!   private event queue whose roundtrips never touch GDK's proxies —
//!   the documented foreign-connection pattern (libwayland is
//!   MT-safe; queues keep the object spaces separate).
//! - `gdk_wayland_window_get_wl_surface` returns NULL while the
//!   window is not mapped — the frontend retries apply until it
//!   lands (hooks/useBlurMyShell.ts).
//!
//! ## Threading
//!
//! All Wayland proxy work happens on the main thread: these are SYNC
//! commands, and wry invokes sync command handlers on the GTK main
//! thread. The session state lives in a thread_local for exactly that
//! thread (the proxy objects are !Send). The two roundtrips during
//! probe happen before the window is shown, so their blocking is
//! invisible.
//!
//! ## Shells
//!
//! Webkit shell only: the CEF shell is `transparent: false`, so
//! compositor blur would be invisible behind its opaque window — it
//! does not mount this module nor register the commands (the
//! frontend's invoke rejects → native unavailable → BMS/opaque
//! fallback, same as today). Non-Linux keeps never-routed stubs so
//! `generate_handler!` compiles everywhere (the notify.rs pattern).

// The command macro must be applied at the `background_effect::*`
// path in every cfg branch (generate_handler! resolves its hidden
// helper modules through that path) — real implementation and stubs
// are cfg'd top-level definitions.

use serde::Serialize;

/// Probe result (serde camelCase for the frontend).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    /// The compositor advertises the protocol WITH the blur capability.
    pub available: bool,
}

/// Apply result (serde camelCase for the frontend).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    /// The effect request landed (false = no session / window not
    /// mapped yet — the frontend retries).
    pub applied: bool,
}

#[cfg(target_os = "linux")]
mod linux {
    use std::cell::RefCell;
    use std::ffi::{c_char, c_void, CStr};
    use std::ptr;

    use gtk::prelude::*;
    use libloading::{Library, Symbol};
    use wayland_client::backend::{Backend, ObjectId};
    use wayland_client::protocol::wl_compositor::{self, WlCompositor};
    use wayland_client::protocol::wl_region::{self, WlRegion};
    use wayland_client::protocol::wl_registry::{self, WlRegistry};
    use wayland_client::protocol::wl_surface::WlSurface;
    use wayland_client::{Connection, Dispatch, QueueHandle, Proxy, WEnum};
    use wayland_protocols::ext::background_effect::v1::client::ext_background_effect_manager_v1::{
        self, Capability, ExtBackgroundEffectManagerV1,
    };
    use wayland_protocols::ext::background_effect::v1::client::ext_background_effect_surface_v1::{
        self, ExtBackgroundEffectSurfaceV1,
    };

    /// A full-surface blur region: surface-local, clipped by the
    /// compositor to the surface size, so one big rect covers every
    /// window scale/size without tracking geometry.
    const REGION_MAX: i32 = 65535;

    // --- GDK bridge (dlopen, see module docs) ------------------------

    /// The resolved GDK Wayland entry points. The `Library` must
    /// outlive every call (the fn pointers would dangle otherwise) —
    /// it is owned by the Session.
    #[derive(Clone, Copy)]
    struct GdkFns {
        display_default: unsafe extern "C" fn() -> *mut c_void,
        display_name: unsafe extern "C" fn(*mut c_void) -> *const c_char,
        display_wl: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
        window_surface: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    }

    impl GdkFns {
        /// dlopen libgdk-3.so.0 and resolve the four symbols. Any miss
        /// (missing library / Wayland-less custom build) reads as
        /// "native blur unavailable".
        unsafe fn load(lib: &Library) -> Option<GdkFns> {
            let display_default: Symbol<unsafe extern "C" fn() -> *mut c_void> =
                lib.get(b"gdk_display_get_default\0").ok()?;
            let display_name: Symbol<unsafe extern "C" fn(*mut c_void) -> *const c_char> =
                lib.get(b"gdk_display_get_name\0").ok()?;
            let display_wl: Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void> =
                lib.get(b"gdk_wayland_display_get_wl_display\0").ok()?;
            let window_surface: Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void> =
                lib.get(b"gdk_wayland_window_get_wl_surface\0").ok()?;
            Some(GdkFns {
                display_default: *display_default,
                display_name: *display_name,
                display_wl: *display_wl,
                window_surface: *window_surface,
            })
        }
    }

    // --- Wayland session over GDK's connection -----------------------

    /// Registry + capability collector for the two probe roundtrips.
    #[derive(Default)]
    struct Globals {
        compositor: Option<(u32, u32)>,
        effect_manager: Option<(u32, u32)>,
        blur_capable: bool,
    }

    impl Dispatch<WlRegistry, ()> for Globals {
        fn event(
            state: &mut Self,
            _registry: &WlRegistry,
            event: wl_registry::Event,
            _data: &(),
            _conn: &Connection,
            _qh: &QueueHandle<Self>,
        ) {
            if let wl_registry::Event::Global { name, interface, version } = event {
                match interface.as_str() {
                    "wl_compositor" => state.compositor = Some((name, version)),
                    "ext_background_effect_manager_v1" => {
                        state.effect_manager = Some((name, version))
                    }
                    _ => {}
                }
            }
        }
    }

    impl Dispatch<ExtBackgroundEffectManagerV1, ()> for Globals {
        fn event(
            state: &mut Self,
            _manager: &ExtBackgroundEffectManagerV1,
            event: ext_background_effect_manager_v1::Event,
            _data: &(),
            _conn: &Connection,
            _qh: &QueueHandle<Self>,
        ) {
            if let ext_background_effect_manager_v1::Event::Capabilities { flags } = event {
                // WEnum::Unknown carries the raw bitfield — honor the
                // blur bit there too (forward compatibility with a
                // newer compositor adding capabilities).
                state.blur_capable = match flags {
                    WEnum::Value(caps) => caps.contains(Capability::Blur),
                    WEnum::Unknown(raw) => raw & Capability::Blur.bits() != 0,
                };
            }
        }
    }

    // No-event proxies our queue owns; empty impls satisfy the
    // Dispatch bound on their constructors (the scanner still emits
    // an empty Event enum for event-less interfaces).
    impl Dispatch<WlCompositor, ()> for Globals {
        fn event(
            _state: &mut Self,
            _proxy: &WlCompositor,
            _event: wl_compositor::Event,
            _data: &(),
            _conn: &Connection,
            _qh: &QueueHandle<Self>,
        ) {
        }
    }
    impl Dispatch<ExtBackgroundEffectSurfaceV1, ()> for Globals {
        fn event(
            _state: &mut Self,
            _proxy: &ExtBackgroundEffectSurfaceV1,
            _event: ext_background_effect_surface_v1::Event,
            _data: &(),
            _conn: &Connection,
            _qh: &QueueHandle<Self>,
        ) {
        }
    }
    impl Dispatch<WlRegion, ()> for Globals {
        fn event(
            _state: &mut Self,
            _proxy: &WlRegion,
            _event: wl_region::Event,
            _data: &(),
            _conn: &Connection,
            _qh: &QueueHandle<Self>,
        ) {
        }
    }

    /// The foreign-connection session: everything needed to speak the
    /// protocol over GDK's wl_display. Owned by the thread_local
    /// STATE (proxy objects are !Send; see module docs). The event
    /// queue itself is not kept: QueueHandle holds an Arc into it, so
    /// the queue's state lives as long as the handle — it only ever
    /// dispatched during init (the capabilities update events are rare
    /// enough to leave queued; the effect object has no events).
    struct Session {
        conn: Connection,
        qh: QueueHandle<Globals>,
        manager: ExtBackgroundEffectManagerV1,
        compositor: WlCompositor,
        fns: GdkFns,
        /// Keeps the dlopen'd GDK alive for `fns` (see GdkFns).
        _lib: Library,
    }

    /// Per-main-thread effect state. `effect` holds the protocol
    /// object for the CURRENT wl_surface — created once per surface
    /// generation, never destroyed across toggles (see apply); only
    /// a surface regeneration explicitly destroys and recreates it.
    struct EffectState {
        session: Session,
        effect: Option<ExtBackgroundEffectSurfaceV1>,
        /// The wl_surface pointer the current `effect` was created
        /// for — GDK3 recreates the surface across unmap/map, and the
        /// effect must follow (the old object goes inert).
        last_surface: *mut c_void,
    }

    thread_local! {
        /// Ok = session live; Err(reason) = unavailable (X11 session,
        /// protocol not advertised, no blur capability, bridge
        /// failure). The outcome is cached: globals and capabilities
        /// cannot change for the connection's lifetime.
        static STATE: RefCell<Option<Result<EffectState, String>>> =
            const { RefCell::new(None) };
    }

    /// Resolve the raw wl_display pointer of GDK's default display.
    /// None on any bridge failure or when the backend is not Wayland.
    unsafe fn gdk_wl_display(fns: GdkFns) -> Option<*mut c_void> {
        let display = (fns.display_default)();
        if display.is_null() {
            return None;
        }
        let name = (fns.display_name)(display);
        if name.is_null() {
            return None;
        }
        let name = CStr::from_ptr(name).to_string_lossy();
        // Only a Wayland GDK backend may be handed to gdk_wayland_*
        // entry points (the X11 display is a different struct — calling
        // the Wayland accessor on it would be undefined behavior).
        if !name.to_ascii_lowercase().contains("wayland") {
            return None;
        }
        let wl = (fns.display_wl)(display);
        if wl.is_null() {
            None
        } else {
            Some(wl)
        }
    }

    /// Build the session (dlopen + foreign connection + registry +
    /// capability check). Returns Err(reason) for a logged dead end.
    fn init_session() -> Result<EffectState, String> {
        unsafe {
            let lib = Library::new("libgdk-3.so.0")
                .or_else(|_| Library::new("libgdk-3.so"))
                .map_err(|e| format!("dlopen libgdk-3: {e}"))?;
            let fns = GdkFns::load(&lib)
                .ok_or_else(|| "gdk wayland symbols missing".to_string())?;
            let wl_display = gdk_wl_display(fns)
                .ok_or_else(|| "GDK display is not Wayland".to_string())?;
            // sys backend: no Result — the NoWaylandLib error only
            // exists for the dlopen flavor.
            let backend = Backend::from_foreign_display(wl_display as *mut _);
            let conn = Connection::from_backend(backend);
            let mut queue = conn.new_event_queue::<Globals>();
            let qh = queue.handle();
            let registry = conn.display().get_registry(&qh, ());
            let mut globals = Globals::default();
            queue
                .roundtrip(&mut globals)
                .map_err(|e| format!("registry roundtrip: {e}"))?;
            let (mgr_name, _) = globals
                .effect_manager
                .ok_or_else(|| "ext-background-effect-v1 not advertised".to_string())?;
            let (comp_name, _) = globals
                .compositor
                .ok_or_else(|| "wl_compositor not advertised".to_string())?;
            let manager: ExtBackgroundEffectManagerV1 = registry.bind(mgr_name, 1, &qh, ());
            let compositor: WlCompositor = registry.bind(comp_name, 1, &qh, ());
            // Second roundtrip delivers the capabilities event sent on
            // bind (the protocol's availability signal).
            queue
                .roundtrip(&mut globals)
                .map_err(|e| format!("capabilities roundtrip: {e}"))?;
            if !globals.blur_capable {
                return Err("compositor advertises the protocol without blur".to_string());
            }
            Ok(EffectState {
                session: Session {
                    conn,
                    qh,
                    manager,
                    compositor,
                    fns,
                    _lib: lib,
                },
                effect: None,
                last_surface: ptr::null_mut(),
            })
        }
    }

    /// Run `f` with the thread's session, lazily initializing once.
    /// The unavailable outcome is cached with its reason (logged at
    /// debug — probe/apply are called only a handful of times).
    fn with_session<R>(f: impl FnOnce(&mut EffectState) -> R) -> Option<R> {
        STATE.with_borrow_mut(|cell| {
            if cell.is_none() {
                let init = init_session().inspect_err(|reason| {
                    log::debug!("background-effect: unavailable: {reason}");
                });
                *cell = Some(init);
            }
            match cell.as_mut().expect("state was just initialized") {
                Ok(state) => Some(f(state)),
                Err(_) => None,
            }
        })
    }

    /// Whether the compositor speaks the protocol with blur support.
    pub fn probe() -> bool {
        with_session(|_| ()).is_some()
    }

    /// Enable/disable the full-surface blur on the given window's
    /// wl_surface. False when the session is dead or the window is
    /// not mapped yet (NULL wl_surface — the frontend retries).
    pub fn apply(window: &tauri::WebviewWindow, enabled: bool) -> bool {
        // The GdkWindow of the toplevel (gtk crate for the widget
        // walk, dlopen for the Wayland accessor — see module docs).
        let gtk_window = match window.gtk_window() {
            Ok(win) => win,
            Err(e) => {
                log::debug!("background-effect: gtk_window(): {e}");
                return false;
            }
        };
        let gdk_window = match gtk_window.window() {
            Some(win) => win,
            // Not realized/mapped yet — the frontend retries.
            None => {
                log::debug!("background-effect: no GdkWindow (window not realized)");
                return false;
            }
        };
        let gdk_window_ptr = gdk_window.as_ptr() as *mut c_void;
        with_session(|state| {
            // Fetch the CURRENT surface pointer — this is what makes
            // apply idempotent across surface generations.
            let surface_ptr = unsafe { (state.session.fns.window_surface)(gdk_window_ptr) };
            if surface_ptr.is_null() {
                log::debug!("background-effect: no wl_surface (window not mapped)");
                return false;
            }
            let EffectState { session, effect, last_surface } = state;
            if *last_surface != surface_ptr {
                // New surface generation: the old effect object is
                // inert (its surface is gone) — destroy it EXPLICITLY
                // and recreate for the new surface below.
                if let Some(old) = effect.take() {
                    old.destroy();
                }
            }
            let landed = (|| -> Result<(), String> {
                let id = unsafe {
                    ObjectId::from_ptr(&WlSurface::interface(), surface_ptr as *mut _)
                }
                .map_err(|e| format!("wrap wl_surface: {e}"))?;
                let surface = WlSurface::from_id(&session.conn, id)
                    .map_err(|e| format!("wl_surface from id: {e}"))?;
                if enabled {
                    if effect.is_none() {
                        // Created ONCE per surface generation and never
                        // destroyed across toggles — see the else branch.
                        *effect =
                            Some(session.manager.get_background_effect(&surface, &session.qh, ()));
                    }
                    // The initial protocol blur region is EMPTY — set
                    // a full-surface rect every time (idempotent).
                    let region = session.compositor.create_region(&session.qh, ());
                    region.add(0, 0, REGION_MAX, REGION_MAX);
                    effect
                        .as_ref()
                        .expect("effect was just ensured")
                        .set_blur_region(Some(&region));
                    region.destroy();
                } else if let Some(effect) = effect.as_ref() {
                    // NULL region is the protocol's official removal.
                    // The effect OBJECT is deliberately never destroyed
                    // across toggles: wayland-client's Proxy drop does
                    // NOT send the destructor request (no generated
                    // Drop impl), so a destroy→recreate cycle would
                    // leave the server believing the surface still has
                    // an effect object — and the next
                    // get_background_effect raises the
                    // background_effect_exists protocol error,
                    // killing the whole connection (live-verified
                    // 2026-11-15: Mutter 51, Gdk "Error 71").
                    effect.set_blur_region(None);
                }
                // NEVER commit the foreign surface ourselves
                // (live-verified 2026-11-15 on Mutter 51: a third-party
                // commit races GDK's own frame state machine —
                // attach/damage/ack_configure sequencing — and the
                // compositor kills the connection with a protocol
                // error, Gdk "Error 71"). The double-buffered region
                // rides GDK's NEXT commit instead, which always comes:
                // every apply accompanies a render change (the
                // translucent↔opaque root background), and the startup
                // apply follows the window's first frame.
                session.conn.flush().map_err(|e| format!("flush: {e}"))?;
                Ok(())
            })();
            match landed {
                Ok(()) => {
                    *last_surface = surface_ptr;
                    true
                }
                Err(e) => {
                    log::warn!("background-effect: apply({enabled}) failed: {e}");
                    // Distrust the half-applied state; rebuild next
                    // time. EXPLICIT destroy again — the drop alone
                    // sends nothing to the server.
                    if let Some(old) = effect.take() {
                        old.destroy();
                    }
                    *last_surface = ptr::null_mut();
                    false
                }
            }
        })
        .unwrap_or(false)
    }
}

/// Probe the native background-effect capability (no window needed —
/// called before the window is shown so the first visible frame is
/// already translucent where supported).
#[cfg(target_os = "linux")]
#[tauri::command]
pub fn background_effect_probe() -> ProbeResult {
    ProbeResult {
        available: linux::probe(),
    }
}

/// Enable/disable the native blur on the calling window. Sync on
/// purpose: the GTK main thread owns the Wayland proxies.
#[cfg(target_os = "linux")]
#[tauri::command]
pub fn background_effect_apply(window: tauri::WebviewWindow, enabled: bool) -> ApplyResult {
    ApplyResult {
        applied: linux::apply(&window, enabled),
    }
}

/// Never-routed stub (the notify.rs pattern) so generate_handler!
/// compiles on non-Linux targets.
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub fn background_effect_probe() -> ProbeResult {
    ProbeResult { available: false }
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub fn background_effect_apply(
    _window: tauri::WebviewWindow,
    _enabled: bool,
) -> ApplyResult {
    ApplyResult { applied: false }
}
