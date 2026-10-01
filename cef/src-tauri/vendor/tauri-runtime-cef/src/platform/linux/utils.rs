// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
  cell::RefCell,
  ffi::CString,
  os::raw::{c_long, c_ulong},
  sync::LazyLock,
};
use x11_dl::xlib;

const NET_WM_STATE_REMOVE: c_long = 0;
const NET_WM_STATE_ADD: c_long = 1;
const NET_ACTIVE_WINDOW_SOURCE_PAGER: c_long = 2;
const CURRENT_TIME: c_long = 0;
const CLIENT_MESSAGE: i32 = 33;
const SUBSTRUCTURE_REDIRECT_MASK: c_long = 1 << 20;
const SUBSTRUCTURE_NOTIFY_MASK: c_long = 1 << 19;

static XLIB: LazyLock<Option<xlib::Xlib>> = LazyLock::new(|| xlib::Xlib::open().ok());

struct Display(*mut xlib::Display);

thread_local! {
  static DISPLAY: RefCell<Option<Display>> = const { RefCell::new(None) };
}

pub(super) fn with_cef_display<R>(
  default: R,
  f: impl FnOnce(&xlib::Xlib, *mut xlib::Display) -> R,
) -> R {
  let Some(xlib) = XLIB.as_ref() else {
    return default;
  };
  let display = cef::get_xdisplay() as *mut xlib::Display;
  if display.is_null() {
    return default;
  }

  let result = f(xlib, display);
  unsafe {
    (xlib.XFlush)(display);
  }
  result
}

pub(super) fn with_x11<R>(default: R, f: impl FnOnce(&xlib::Xlib, *mut xlib::Display) -> R) -> R {
  let Some(xlib) = XLIB.as_ref() else {
    return default;
  };

  DISPLAY.with(|cell| {
    let mut guard = cell.borrow_mut();
    if guard.is_none() {
      let display = unsafe { (xlib.XOpenDisplay)(std::ptr::null()) };
      if display.is_null() {
        return default;
      }
      *guard = Some(Display(display));
    }

    let display = guard.as_ref().unwrap().0;
    let result = f(xlib, display);
    unsafe {
      (xlib.XFlush)(display);
    }
    result
  })
}

pub(super) fn atom(xlib: &xlib::Xlib, display: *mut xlib::Display, name: &str) -> c_ulong {
  let cname = CString::new(name).unwrap();
  unsafe { (xlib.XInternAtom)(display, cname.as_ptr(), 0) }
}

/// Ask the window manager to begin an interactive move of `xid`
/// (`_NET_WM_MOVERESIZE`), anchored at the current pointer position.
///
/// gtk4-winit's `drag_window` needs the GTK toplevel to have seen the button
/// press, but CEF's browser is its own X child window that consumes every
/// button event, so that state is never set and dragging always errors out
/// ("window dragging requires a pointer button press") — see
/// tauri-apps/tauri#14936. Sending the EWMH message directly works regardless
/// of which X window actually saw the press.
///
/// lumina-code cef branch local patch.
pub(super) fn start_window_drag(xid: c_ulong) -> bool {
  with_cef_display(false, |xlib, display| unsafe {
    let root = (xlib.XDefaultRootWindow)(display);
    let mut root_return = 0;
    let mut child_return = 0;
    let mut root_x = 0;
    let mut root_y = 0;
    let mut win_x = 0;
    let mut win_y = 0;
    let mut mask = 0;
    if (xlib.XQueryPointer)(
      display,
      xid,
      &mut root_return,
      &mut child_return,
      &mut root_x,
      &mut root_y,
      &mut win_x,
      &mut win_y,
      &mut mask,
    ) == 0
    {
      return false;
    }

    // Release the implicit passive grab the button press put on the CEF
    // browser's X window. This is CEF's own display connection — the grab
    // owner — so the ungrab is honored and the window manager is free to
    // grab the pointer for the move gesture (same recipe as winit's X11
    // drag_initiate).
    (xlib.XUngrabPointer)(display, CURRENT_TIME as xlib::Time);

    let net_wm_moveresize = atom(xlib, display, "_NET_WM_MOVERESIZE");
    let mut event: xlib::XEvent = std::mem::zeroed();
    event.client_message = xlib::XClientMessageEvent {
      type_: CLIENT_MESSAGE,
      serial: 0,
      send_event: 1,
      display,
      window: xid,
      message_type: net_wm_moveresize,
      format: 32,
      data: xlib::ClientMessageData::from([
        root_x as c_long,
        root_y as c_long,
        8, // _NET_WM_MOVERESIZE_MOVE
        1, // button 1
        1, // source indication: application
      ]),
    };
    (xlib.XSendEvent)(
      display,
      root,
      0,
      SUBSTRUCTURE_REDIRECT_MASK | SUBSTRUCTURE_NOTIFY_MASK,
      &mut event,
    );
    true
  })
}

/// Ask the window manager to make `xid` the active window.
///
/// The source indication is `2` ("pager"): EWMH tells window managers to treat
/// those requests as if they came from the user, which is what gets past the
/// focus-stealing prevention that would otherwise turn the request into a
/// taskbar highlight. `1` ("application") would need a valid user input
/// timestamp we do not have when a window is created.
pub(super) fn activate_window(xid: c_ulong) {
  with_x11((), |xlib, display| {
    let net_active_window = atom(xlib, display, "_NET_ACTIVE_WINDOW");

    unsafe {
      (xlib.XRaiseWindow)(display, xid);

      let root = (xlib.XDefaultRootWindow)(display);
      let mut event: xlib::XEvent = std::mem::zeroed();
      event.client_message = xlib::XClientMessageEvent {
        type_: CLIENT_MESSAGE,
        serial: 0,
        send_event: 1,
        display,
        window: xid,
        message_type: net_active_window,
        format: 32,
        data: xlib::ClientMessageData::from([
          NET_ACTIVE_WINDOW_SOURCE_PAGER,
          CURRENT_TIME,
          // No requestor window: the request is about our own window.
          0,
          0,
          0,
        ]),
      };
      (xlib.XSendEvent)(
        display,
        root,
        0,
        SUBSTRUCTURE_REDIRECT_MASK | SUBSTRUCTURE_NOTIFY_MASK,
        &mut event,
      );
    }
  });
}

pub(super) fn set_wm_state(xid: c_ulong, add: bool, atom1: &str, atom2: Option<&str>) {
  with_x11((), |xlib, display| {
    let wm_state = atom(xlib, display, "_NET_WM_STATE");
    let a1 = atom(xlib, display, atom1);
    let a2 = atom2.map(|name| atom(xlib, display, name)).unwrap_or(0);
    let action = if add {
      NET_WM_STATE_ADD
    } else {
      NET_WM_STATE_REMOVE
    };

    unsafe {
      let root = (xlib.XDefaultRootWindow)(display);
      let mut event: xlib::XEvent = std::mem::zeroed();
      event.client_message = xlib::XClientMessageEvent {
        type_: CLIENT_MESSAGE,
        serial: 0,
        send_event: 1,
        display,
        window: xid,
        message_type: wm_state,
        format: 32,
        data: xlib::ClientMessageData::from([action, a1 as c_long, a2 as c_long, 1, 0]),
      };
      (xlib.XSendEvent)(
        display,
        root,
        0,
        SUBSTRUCTURE_REDIRECT_MASK | SUBSTRUCTURE_NOTIFY_MASK,
        &mut event,
      );
    }
  });
}
