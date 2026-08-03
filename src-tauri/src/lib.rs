// USAHP Tauri demo — embeds the usahp event broker in-process.
//
// The Tauri `setup` hook replays usahpd's `main` (parse config → spawn
// broker → spawn input capture → bind the loopback WebSocket → serve) on
// Tauri's async runtime. One process, one language: the webview loads
// scan-engine-lab; the Rust backend IS the switch daemon.

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tokio::sync::mpsc;

#[cfg(target_os = "macos")]
mod macos_capture;

const EMBEDDED_CONFIG: &str = include_str!("../resources/default-config.toml");

/// Output routing mode.
#[derive(Debug, Clone, Default, PartialEq)]
enum OutputMode {
    #[default]
    Disabled,
    /// switch_id → macOS/win keycode
    Keystroke(std::collections::HashMap<String, u16>),
    /// Grid 3 native protocol (Windows SendNotifyMessageA, up to 8 switches).
    /// switch_N → Grid switch N (automatic).
    Grid3,
}

#[derive(Clone)]
enum CaptureHandle {
    Core(usahp_daemon::input::CaptureControl),
    #[cfg(target_os = "macos")]
    MacOs(Arc<AtomicBool>),
}

impl CaptureHandle {
    fn enabled(&self) -> bool {
        match self {
            Self::Core(control) => control.enabled(),
            #[cfg(target_os = "macos")]
            Self::MacOs(flag) => flag.load(Ordering::Relaxed),
        }
    }

    async fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        match self {
            Self::Core(control) => if enabled {
                control.resume().await
            } else {
                control.pause().await
            }
            .map_err(|error| error.to_string()),
            #[cfg(target_os = "macos")]
            Self::MacOs(flag) => {
                flag.store(enabled, Ordering::Relaxed);
                Ok(())
            }
        }
    }
}

/// Handle on the running broker so commands can inspect and control it.
struct AppState {
    #[allow(dead_code)]
    broker: mpsc::Sender<usahp_daemon::broker::BrokerCommand>,
    port: u16,
    switches: Vec<String>,
    /// Set when a platform capture backend is installed.
    capture: Option<CaptureHandle>,
    /// Output routing state.
    output: Arc<std::sync::Mutex<OutputMode>>,
    /// Monitor client ID (set when the session monitor registers).
    monitor_client_id: Arc<std::sync::Mutex<Option<u64>>>,
    /// Active session ID (set when a managed session is accepted).
    session_id: Arc<std::sync::Mutex<Option<String>>>,
}

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "usahp=info,usahp_tauri_demo=info".into()),
        )
        .try_init();
}

/// Frontend-facing snapshot of the embedded broker.
#[tauri::command]
fn usahp_status(state: State<'_, AppState>) -> serde_json::Value {
    let output_active = state
        .output
        .lock()
        .map(|m| !matches!(*m, OutputMode::Disabled))
        .unwrap_or(false);
    let output_mode = state
        .output
        .lock()
        .map(|m| match &*m {
            OutputMode::Disabled => "disabled",
            OutputMode::Keystroke(_) => "keystroke",
            OutputMode::Grid3 => "grid3",
        })
        .unwrap_or("disabled");
    serde_json::json!({
        "running": true,
        "port": state.port,
        "switches": state.switches,
        "capture_installed": state.capture.is_some(),
        "capturing": state.capture.as_ref().map(CaptureHandle::enabled).unwrap_or(false),
        "output_active": output_active,
        "output_mode": output_mode,
    })
}

/// Pause/resume the OS-level switch capture so the user can free their keys
/// without quitting. No-op when the app is running in webview-only mode.
#[tauri::command]
async fn set_capture(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    if let Some(capture) = state.capture.as_ref() {
        capture.set_enabled(enabled).await?;
        tracing::info!(
            enabled,
            "USAHP capture {}",
            if enabled { "resumed" } else { "released" }
        );
    }
    Ok(())
}

/// Configure output routing: translate broker switch events to external apps.
/// Modes: "keystroke" (OS keystrokes, cross-platform), "grid3" (Grid 3 native
/// Windows protocol, up to 8 switches), "disabled".
#[tauri::command]
fn set_output(
    state: State<'_, AppState>,
    mode: String,
    mapping: Option<std::collections::HashMap<String, u16>>,
) {
    if let Ok(mut out) = state.output.lock() {
        *out = match mode.as_str() {
            "keystroke" => OutputMode::Keystroke(mapping.unwrap_or_default()),
            "grid3" => OutputMode::Grid3,
            _ => OutputMode::Disabled,
        };
        tracing::info!("output routing: {:?}", *out);
    }
}

/// Inject a switch edge into the embedded broker (used by on-screen buttons so
/// they route through USAHP like physical keys do). mapping id == switch id in
/// the demo config, so the client addresses a switch directly.
#[tauri::command]
async fn inject_switch(
    state: State<'_, AppState>,
    switch_id: String,
    pressed: bool,
) -> Result<(), String> {
    let action = if pressed {
        usahp_core::Action::Pressed
    } else {
        usahp_core::Action::Released
    };
    let confidence = if pressed { Some(100.0) } else { Some(0.0) };
    state
        .broker
        .send(usahp_daemon::broker::BrokerCommand::Input(
            usahp_daemon::broker::PhysicalEvent {
                mapping_id: switch_id,
                action,
                confidence,
            },
        ))
        .await
        .map_err(|e| e.to_string())
}

/// Claim a managed session (exclusive_foreground). Demonstrates heartbeat,
/// escape hatch, and focus-driven revocation.
#[tauri::command]
async fn claim_session(state: State<'_, AppState>) -> Result<(), String> {
    let client_id = state
        .monitor_client_id
        .lock()
        .map_err(|e| e.to_string())?
        .ok_or("monitor not registered")?;

    state
        .broker
        .send(usahp_daemon::broker::BrokerCommand::Handshake {
            client_id,
            handshake: usahp_core::Handshake {
                protocol_version: usahp_core::PROTOCOL_VERSION.into(),
                app_id: "org.usahp.tauri-demo".into(),
                requested_mode: usahp_core::RequestedMode::ExclusiveForeground,
                pid: Some(std::process::id() as u32),
            },
        })
        .await
        .map_err(|e| e.to_string())
}

/// Release the active managed session.
#[tauri::command]
async fn release_session(state: State<'_, AppState>) -> Result<(), String> {
    state
        .broker
        .send(usahp_daemon::broker::BrokerCommand::RevokeSession {
            reason: usahp_core::SessionRevocationReason::ExplicitRevocation,
        })
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config =
                usahp_core::Config::parse(EMBEDDED_CONFIG).expect("invalid embedded USAHP config");
            usahp_daemon::input::validate(&config.mappings)
                .expect("invalid embedded USAHP mappings");

            let port = config.server.port;
            let capacity = config.server.client_queue_capacity;
            let mut switches: Vec<String> = config
                .mappings
                .iter()
                .map(|m| m.switch_id.clone())
                .collect();
            switches.sort();
            switches.dedup();

            // broker::spawn and server::serve call tokio::spawn internally, so
            // they need a current runtime — block_on enters it and still lets
            // us return the broker handle synchronously.
            let (broker, capture_control) = tauri::async_runtime::block_on(async {
                let capture = usahp_daemon::input::CaptureControl::new_enabled();
                let broker = usahp_daemon::broker::spawn(config.mappings.clone(), capture.clone());
                let server_broker = broker.clone();
                tauri::async_runtime::spawn(async move {
                    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                        Ok(listener) => listener,
                        Err(error) => {
                            tracing::error!(%error, port, "USAHP WebSocket bind failed");
                            return;
                        }
                    };
                    tracing::info!(
                        "USAHP WebSocket server listening on http://127.0.0.1:{}",
                        port
                    );
                    if let Err(error) =
                        usahp_daemon::server::serve(listener, server_broker, capacity).await
                    {
                        tracing::error!(%error, "USAHP server ended");
                    }
                });
                (broker, capture)
            });

            // OS-level switch capture is OFF by default (capture happens in the
            // webview → inject_switch). Set USAHP_GRAB=1 for real system-wide
            // capture: a native CGEventTap on macOS (rdev's grab traps in
            // TextServices), or usahp's rdev/evdev on Linux/Windows. The flag
            // returned here lets `set_capture` pause/resume the backend at runtime.
            let capture: Option<CaptureHandle> = if std::env::var("USAHP_GRAB")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false)
            {
                // On macOS use the native CGEventTap (rdev's macOS grab traps in
                // TextServices on the first key). Elsewhere use usahp's rdev/evdev.
                #[cfg(target_os = "macos")]
                {
                    macos_capture::spawn(&config.mappings, broker.clone()).map(CaptureHandle::MacOs)
                }
                #[cfg(not(target_os = "macos"))]
                {
                    match usahp_daemon::input::spawn(
                        &config.mappings,
                        broker.clone(),
                        capture_control.clone(),
                    ) {
                        Ok(()) => Some(CaptureHandle::Core(capture_control.clone())),
                        Err(error) => {
                            tracing::error!(%error, "USAHP input backend failed to start");
                            None
                        }
                    }
                }
            } else {
                tracing::info!(
                    "USAHP OS grab disabled (set USAHP_GRAB=1 to enable). Capture is via the \
                     webview → inject_switch."
                );
                None
            };

            // macOS: watch frontmost application for focus-driven session
            // revocation (Stage 2). No-op if no managed session is active.
            #[cfg(target_os = "macos")]
            usahp_daemon::focus_watcher::spawn(broker.clone());

            // Shared state for session management.
            let monitor_client_id: Arc<std::sync::Mutex<Option<u64>>> =
                Arc::new(std::sync::Mutex::new(None));
            let session_id: Arc<std::sync::Mutex<Option<String>>> =
                Arc::new(std::sync::Mutex::new(None));

            // Session event monitor: register the backend as a broker client
            // and forward session lifecycle events (HandshakeResponse,
            // SessionRevoked) to the frontend via Tauri events.
            if let Some(window) = app.get_webview_window("main") {
                let mon_broker = broker.clone();
                let mon_win = window.clone();
                let mon_cid = monitor_client_id.clone();
                let mon_sid = session_id.clone();
                tauri::async_runtime::spawn(async move {
                    let (tx, mut rx) =
                        tokio::sync::mpsc::channel::<std::sync::Arc<usahp_core::ServerMessage>>(16);
                    let (reply, result) = tokio::sync::oneshot::channel();
                    let _ = mon_broker
                        .send(usahp_daemon::broker::BrokerCommand::Register { sender: tx, reply })
                        .await;
                    let client_id = result.await.unwrap_or(0);
                    if let Ok(mut cid) = mon_cid.lock() {
                        *cid = Some(client_id);
                    }
                    // Drain hello (we don't need it for monitoring).
                    let _ = rx.recv().await;

                    // Spawn heartbeat task: sends heartbeats while a session is active.
                    let hb_broker = mon_broker.clone();
                    let hb_cid = mon_cid.clone();
                    let hb_sid = mon_sid.clone();
                    tokio::spawn(async move {
                        let mut interval = tokio::time::interval(Duration::from_millis(500));
                        interval.tick().await; // skip immediate
                        loop {
                            interval.tick().await;
                            let (Some(cid), Some(sid)) = (
                                hb_cid.lock().map(|g| *g).ok().flatten(),
                                hb_sid.lock().map(|g| g.clone()).ok().flatten(),
                            ) else {
                                continue;
                            };
                            let _ = hb_broker
                                .send(usahp_daemon::broker::BrokerCommand::Heartbeat {
                                    client_id: cid,
                                    session_id: sid,
                                })
                                .await;
                        }
                    });

                    while let Some(msg) = rx.recv().await {
                        match &*msg {
                            usahp_core::ServerMessage::HandshakeResponse(resp) => {
                                if let usahp_core::HandshakeResponse::Accepted {
                                    session_id: sid, ..
                                } = resp
                                {
                                    if let Ok(mut s) = mon_sid.lock() {
                                        *s = Some(sid.clone());
                                    }
                                }
                                let msg = match resp {
                                    usahp_core::HandshakeResponse::Accepted { .. } => {
                                        "Session claimed".to_string()
                                    }
                                    usahp_core::HandshakeResponse::Rejected { reason, .. } => {
                                        format!("Handshake rejected: {reason:?}")
                                    }
                                };
                                let _ = mon_win.emit("usahp-session-event", msg);
                            }
                            usahp_core::ServerMessage::SessionRevoked(rev) => {
                                if let Ok(mut s) = mon_sid.lock() {
                                    *s = None;
                                }
                                let reason = match rev.reason {
                                    usahp_core::SessionRevocationReason::EscapeHatch => {
                                        "Escape hatch — switch held > 4s"
                                    }
                                    usahp_core::SessionRevocationReason::FocusLost => {
                                        "Focus lost — another app came to front"
                                    }
                                    usahp_core::SessionRevocationReason::HeartbeatTimeout => {
                                        "Heartbeat timeout"
                                    }
                                    usahp_core::SessionRevocationReason::QueueOverflow => {
                                        "Queue overflow"
                                    }
                                    usahp_core::SessionRevocationReason::ExplicitRevocation => {
                                        "Released"
                                    }
                                };
                                let _ = mon_win
                                    .emit("usahp-session-event", format!("Session revoked: {reason}"));
                            }
                            _ => {}
                        }
                    }
                });
            }

            // Output routing: a second broker client that translates switch_events
            // to OS-level keystrokes when output mapping is active.
            let output: Arc<std::sync::Mutex<OutputMode>> =
                Arc::new(std::sync::Mutex::new(OutputMode::Disabled));
            let out_broker = broker.clone();
            let out_state = output.clone();
            tauri::async_runtime::spawn(async move {
                let (tx, mut rx) =
                    tokio::sync::mpsc::channel::<std::sync::Arc<usahp_core::ServerMessage>>(16);
                let (reply, result) = tokio::sync::oneshot::channel();
                let _ = out_broker
                    .send(usahp_daemon::broker::BrokerCommand::Register { sender: tx, reply })
                    .await;
                let _ = result.await;
                let _ = rx.recv().await; // hello
                while let Some(msg) = rx.recv().await {
                    if let usahp_core::ServerMessage::SwitchEvent(ev) = &*msg {
                        let is_press = ev.action == usahp_core::Action::Pressed;
                        let mode = out_state.lock().ok();
                        if let Some(mode) = mode.as_deref() {
                            match mode {
                                OutputMode::Keystroke(map) => {
                                    if let Some(&_keycode) = map.get(&ev.switch_id) {
                                        #[cfg(target_os = "macos")]
                                        {
                                            macos_capture::post_keystroke(_keycode, is_press);
                                        }
                                        #[cfg(not(target_os = "macos"))]
                                        {
                                            tracing::warn!(
                                                "keystroke output not yet on this platform"
                                            );
                                        }
                                    }
                                }
                                OutputMode::Grid3 => {
                                    // switch_N → Grid switch N.
                                    if let Some(n) = ev.switch_id.strip_prefix("switch_") {
                                        if let Ok(switch_num) = n.parse::<u32>() {
                                            #[cfg(target_os = "windows")]
                                            {
                                                grid3_send(switch_num, is_press);
                                            }
                                            #[cfg(not(target_os = "windows"))]
                                            {
                                                let _ = switch_num;
                                                tracing::warn!("Grid 3 output is Windows-only");
                                            }
                                        }
                                    }
                                }
                                OutputMode::Disabled => {}
                            }
                        }
                    }
                }
            });

            app.manage(AppState {
                broker,
                port,
                switches,
                capture,
                output,
                monitor_client_id,
                session_id,
            });

            // USAHP handoff (software, exclusive_foreground): the frontend drives
            // capture on window focus — focused → app grabs the switches, blurred
            // → keys pass through to the OS / Apple Switch Control. We just emit
            // focus changes; the frontend owns the capture decision.
            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(focused) = event {
                        let _ = win.emit("usahp-focus", *focused);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            usahp_status,
            inject_switch,
            set_capture,
            set_output,
            claim_session,
            release_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Send a Grid 3 switch event via the Windows `Sensory_SwitchInput` protocol.
/// Grid 3 registers a custom window message and listens for
/// `SendNotifyMessageA(HWND_BROADCAST, msg, switch_num, press_flag)` where
/// `press_flag` is 1 for press, 0 for release.
#[cfg(target_os = "windows")]
fn grid3_send(switch_num: u32, press: bool) {
    use std::sync::OnceLock;
    use windows::core::s;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        RegisterWindowMessageA, SendNotifyMessageA, HWND_BROADCAST,
    };

    static MSG: OnceLock<u32> = OnceLock::new();
    let msg = *MSG.get_or_init(|| unsafe { RegisterWindowMessageA(s!("Sensory_SwitchInput")) });
    unsafe {
        let _ = SendNotifyMessageA(
            HWND_BROADCAST,
            msg,
            WPARAM(switch_num as usize),
            LPARAM(if press { 1 } else { 0 }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::CaptureHandle;

    #[tokio::test]
    async fn core_capture_handle_reports_pause_and_resume() {
        let handle = CaptureHandle::Core(usahp_daemon::input::CaptureControl::new_enabled());

        assert!(handle.enabled());
        handle.set_enabled(false).await.expect("pause capture");
        assert!(!handle.enabled());
        handle.set_enabled(true).await.expect("resume capture");
        assert!(handle.enabled());
    }
}
