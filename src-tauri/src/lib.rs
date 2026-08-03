// USAHP Tauri demo — embeds the usahp event broker in-process.
//
// The Tauri `setup` hook replays usahpd's `main` (parse config → spawn
// broker → spawn input capture → bind the loopback WebSocket → serve) on
// Tauri's async runtime. One process, one language: the webview loads
// scan-engine-lab; the Rust backend IS the switch daemon.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::sync::mpsc;

#[cfg(target_os = "macos")]
mod macos_capture;

const EMBEDDED_CONFIG: &str = include_str!("../resources/default-config.toml");

/// Handle on the running broker so (later) commands can inject events.
struct AppState {
    #[allow(dead_code)]
    broker: mpsc::Sender<usahp_daemon::broker::BrokerCommand>,
    port: u16,
    switches: Vec<String>,
    /// Set when the macOS CGEventTap is installed; clear it to release capture.
    capture_flag: Option<Arc<AtomicBool>>,
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
    serde_json::json!({
        "running": true,
        "port": state.port,
        "switches": state.switches,
        "capture_installed": state.capture_flag.is_some(),
        "capturing": state
            .capture_flag
            .as_ref()
            .map(|f| f.load(Ordering::Relaxed))
            .unwrap_or(false),
    })
}

/// Pause/resume the OS-level switch capture (so the user can free their keys
/// without quitting). No-op if the tap isn't installed.
#[tauri::command]
fn set_capture(state: State<'_, AppState>, enabled: bool) {
    if let Some(flag) = state.capture_flag.as_ref() {
        flag.store(enabled, Ordering::Relaxed);
        tracing::info!(
            enabled,
            "USAHP capture {}",
            if enabled { "resumed" } else { "released" }
        );
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
    state
        .broker
        .send(usahp_daemon::broker::BrokerCommand::Input(
            usahp_daemon::broker::PhysicalEvent {
                mapping_id: switch_id,
                action,
            },
        ))
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config = usahp_core::Config::parse(EMBEDDED_CONFIG)
                .expect("invalid embedded USAHP config");
            usahp_daemon::input::validate(&config.mappings)
                .expect("invalid embedded USAHP mappings");

            let port = config.server.port;
            let capacity = config.server.client_queue_capacity;
            let mut switches: Vec<String> =
                config.mappings.iter().map(|m| m.switch_id.clone()).collect();
            switches.sort();
            switches.dedup();

            // broker::spawn and server::serve call tokio::spawn internally, so
            // they need a current runtime — block_on enters it and still lets
            // us return the broker handle synchronously.
            let broker = tauri::async_runtime::block_on(async {
                let broker = usahp_daemon::broker::spawn(config.mappings.clone());
                let server_broker = broker.clone();
                tauri::async_runtime::spawn(async move {
                    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                        Ok(listener) => listener,
                        Err(error) => {
                            tracing::error!(%error, port, "USAHP WebSocket bind failed");
                            return;
                        }
                    };
                    tracing::info!("USAHP WebSocket server listening on http://127.0.0.1:{}", port);
                    if let Err(error) =
                        usahp_daemon::server::serve(listener, server_broker, capacity).await
                    {
                        tracing::error!(%error, "USAHP server ended");
                    }
                });
                broker
            });

            // OS-level switch capture is OFF by default (capture happens in the
            // webview → inject_switch). Set USAHP_GRAB=1 for real system-wide
            // capture: a native CGEventTap on macOS (rdev's grab traps in
            // TextServices), or usahp's rdev/evdev on Linux/Windows. The flag
            // returned here lets `set_capture` pause/resume the tap at runtime.
            let capture_flag: Option<Arc<AtomicBool>> = if std::env::var("USAHP_GRAB")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false)
            {
                // On macOS use the native CGEventTap (rdev's macOS grab traps in
                // TextServices on the first key). Elsewhere use usahp's rdev/evdev.
                #[cfg(target_os = "macos")]
                {
                    macos_capture::spawn(&config.mappings, broker.clone())
                }
                #[cfg(not(target_os = "macos"))]
                {
                    if let Err(error) = usahp_daemon::input::spawn(&config.mappings, broker.clone()) {
                        tracing::error!(%error, "USAHP input backend failed to start");
                    }
                    None
                }
            } else {
                tracing::info!(
                    "USAHP OS grab disabled (set USAHP_GRAB=1 to enable). Capture is via the \
                     webview → inject_switch."
                );
                None
            };

            app.manage(AppState {
                broker,
                port,
                switches,
                capture_flag,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![usahp_status, inject_switch, set_capture])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
