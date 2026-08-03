//! Native macOS keyboard capture via a CGEventTap — a drop-in replacement for
//! `usahp`'s `rdev` grab on macOS.
//!
//! Why this exists: `rdev`'s macOS event-tap callback calls HIToolbox
//! TextServices (`TSMGetInputSourceProperty`) to build key *names*, which
//! asserts it runs on the main queue and traps (`SIGTRAP`) on the first event
//! — killing the process. We only ever need the keycode, so this tap reads it
//! directly and never touches TextServices. Mapped keys are suppressed (dropped
//! here) and routed to the broker exactly like `usahp_daemon::input`.

#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use core_foundation::runloop::CFRunLoop;
use core_graphics::event::{
    CallbackResult, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
};
use tokio::sync::mpsc;
use usahp_core::{Action, InputKind, Mapping};
use usahp_daemon::broker::{BrokerCommand, PhysicalEvent};

/// kCGKeyboardEventKeycode
const KEYCODE_FIELD: u32 = 9;

/// usahp key-name → macOS virtual keycode (mirrors rdev's mapping for the keys
/// `usahp::input::parse_key` accepts).
fn name_to_keycode() -> HashMap<&'static str, u16> {
    let raw: &[(&str, u16)] = &[
        ("space", 49),
        ("return", 36),
        ("enter", 36),
        ("escape", 53),
        ("esc", 53),
        ("tab", 48),
        ("up", 126), ("uparrow", 126),
        ("down", 125), ("downarrow", 125),
        ("left", 123), ("leftarrow", 123),
        ("right", 124), ("rightarrow", 124),
        ("a", 0), ("b", 11), ("c", 8), ("d", 2), ("e", 14), ("f", 3), ("g", 5),
        ("h", 4), ("i", 34), ("j", 38), ("k", 40), ("l", 37), ("m", 46), ("n", 45),
        ("o", 31), ("p", 35), ("q", 12), ("r", 15), ("s", 1), ("t", 17), ("u", 32),
        ("v", 9), ("w", 13), ("x", 7), ("y", 16), ("z", 6),
    ];
    raw.iter().copied().collect()
}

/// Install a session CGEventTap on a dedicated thread that turns the configured
/// keyboard mappings into broker `Input` commands and suppresses the captured
/// keys. Requires macOS Accessibility permission; logs + returns otherwise.
///
/// Returns a flag the caller can clear to release capture (keys then pass
/// through to the OS again). `None` if no tap was installed.
pub fn spawn(mappings: &[Mapping], broker: mpsc::Sender<BrokerCommand>) -> Option<Arc<AtomicBool>> {
    let names = name_to_keycode();
    let mut by_key: HashMap<u16, Vec<String>> = HashMap::new();
    for m in mappings.iter().filter(|m| m.input == InputKind::Keyboard) {
        if let Some(&kc) = names.get(m.code.to_ascii_lowercase().as_str()) {
            by_key.entry(kc).or_default().push(m.id.clone());
        }
    }
    if by_key.is_empty() {
        tracing::warn!("no capturable keyboard mappings; macOS tap not installed");
        return None;
    }
    let capture = Arc::new(AtomicBool::new(true));
    let by_key = Arc::new(by_key);
    let capture_for_cb = capture.clone();

    if let Err(error) = std::thread::Builder::new()
        .name("usahp-macos-tap".into())
        .spawn(move || {
            let broker = broker;
            let by_key = by_key;
            let capture = capture_for_cb;
            tracing::info!(
                "installing macOS CGEventTap for {} keycode(s) — needs Accessibility",
                by_key.len()
            );
            // with_enabled creates the tap, enables it, runs `with_fn`
            // (the run loop) on this thread, and drops the tap on return.
            let installed = CGEventTap::with_enabled(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::Default,
                vec![CGEventType::KeyDown, CGEventType::KeyUp],
                move |_proxy, event_type, event| {
                    // Capture released: pass everything through untouched.
                    if !capture.load(Ordering::Relaxed) {
                        return CallbackResult::Keep;
                    }
                    let keycode = event.get_integer_value_field(KEYCODE_FIELD) as u16;
                    let action = match event_type {
                        CGEventType::KeyDown => Action::Pressed,
                        CGEventType::KeyUp => Action::Released,
                        _ => return CallbackResult::Keep,
                    };
                    if let Some(ids) = by_key.get(&keycode) {
                        for id in ids {
                            if broker
                                .blocking_send(BrokerCommand::Input(PhysicalEvent {
                                    mapping_id: id.clone(),
                                    action,
                                }))
                                .is_err()
                            {
                                break;
                            }
                        }
                        CallbackResult::Drop // suppress: key is consumed by USAHP
                    } else {
                        CallbackResult::Keep
                    }
                },
                || CFRunLoop::run_current(),
            );
            if installed.is_err() {
                tracing::error!(
                    "CGEventTap install failed — grant Accessibility to this app \
                     (System Settings → Privacy → Accessibility) and restart"
                );
            }
        })
    {
        tracing::error!(%error, "could not spawn macOS tap thread");
        return None;
    }
    Some(capture)
}
