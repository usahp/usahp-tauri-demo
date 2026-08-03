# usahp-tauri-demo

A cross-platform desktop demo that embeds the [USAHP](https://github.com/OwenMcGirr/usahp) v0.2 switch-event broker **in-process** inside a [Tauri 2](https://tauri.app) app, with a switch-scanner webview built on the published [`scan-engine`](https://www.npmjs.com/package/scan-engine) + [`switch-input`](https://www.npmjs.com/package/switch-input) packages.

> Proves the chain end to end: **physical switch → embedded Rust broker → loopback WebSocket → scanner UI**, with no separate daemon binary to install. On-screen switch buttons route through the broker too, via a Tauri command.

## Architecture

```
┌──────────────────────────── Tauri app (one process) ────────────────────────────┐
│                                                                                 │
│  Rust backend (src-tauri)                        Webview frontend (src/main.ts)  │
│  ┌──────────────────────────────┐  WS            ┌───────────────────────────┐  │
│  │ usahp-daemon (embedded)       │  127.0.0.1:7312│ scan-engine (scanner)     │  │
│  │  ├─ broker (state machine)    │◄───────────────│ switch-input              │  │
│  │  ├─ input (rdev/evdev grab)   │                │  └─ UsahpAdapter          │  │
│  │  └─ server (WebSocket :7312)  │  inject_switch │ on-screen buttons ────────┼──┤
│  └──────────────────────────────┘ ──────────────►│ (route through the broker) │  │
│                                                  └───────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

The `setup` hook replays `usahpd`'s `main` on Tauri's async runtime: parse the embedded config → spawn the broker → spawn OS input capture → bind the loopback WebSocket → serve. The webview is the app's own vite frontend; `scan-engine` + `switch-input` come from npm.

## What this app is (and isn't)

This demo is **three things in one window**, combined for convenience. In production, these are separate components.

### 1. A USAHP-native scanner (Scanner tab)

A switch scanner built on `scan-engine` + `switch-input` from npm. It connects to the broker via WebSocket, receives `switch_event` frames through `UsahpAdapter`, and drives a `GestureEngine` → scanner. Multiple strategies: row-column, linear, snake, quadrant, elimination (4-colour), continuous (gliding/crosshair/radar).

**Any app can do this** — install `scan-engine` + `switch-input` from npm, connect to `ws://127.0.0.1:7312`, and you're a USAHP consumer. No Manager, no configuration, no bridge needed.

### 2. A broker admin panel (Manager tab)

Configuration and monitoring for the embedded broker: switch mappings, failsafe config (heartbeat interval, missed limit), live status, session log, and broker activity stats (dwell times, events/min).

**This belongs in a standalone system app** (menu bar on macOS, system tray on Windows/Linux) — not inside a consumer app. The demo combines them for convenience; the production version is tracked as Phase 12 in the [build plan](https://github.com/AACTools/usahp-spec/blob/main/USAHP-Tauri-Demo-Build-Plan.md).

### 3. An output bridge (Manager tab → Output routing)

Translates broker events to protocols that non-USAHP apps understand:

- **Keystroke mode**: `switch_event` → OS-level keystroke (`CGEventPost` on macOS, `SendInput` on Windows). Any keyboard-reading app (games, Terminal, browsers) receives the switch.
- **Grid 3 mode**: `switch_event` → `SendNotifyMessageA("Sensory_SwitchInput")` (Windows only, up to 8 switches). Grid 3 receives the switch natively.

**This is only needed for apps that don't speak USAHP natively.** A future Grid 4 with built-in USAHP support would connect to the WebSocket directly — no bridge, no output routing, no keystroke emulation. The bridge is a compatibility layer for the current generation of AAC software.

### The production architecture (where this is heading)

```
usahpd (background service / system driver)
    │
    ├── Native USAHP apps (just connect via WebSocket — no config)
    │     ├── Scanners (this demo's Scanner tab, minus the Manager)
    │     ├── Web apps (UsahpAdapter from npm)
    │     └── Future: Grid 4, Communicator 5, etc.
    │
    ├── Output bridge (for non-native apps)
    │     ├── Grid 3 (SendNotifyMessageA or keystrokes)
    │     └── Games / educational software (keystrokes)
    │
    └── System app (menu bar / tray — Phase 12)
          ├── Switch mapping editor
          ├── Failsafe config (heartbeat, escape hold, arbitration)
          ├── Broker status + session log
          ├── Output routing config
          └── Start at login
```

This demo proves all three pieces work. The next step is to split them into proper standalone components.

## Prerequisites

- **Rust** (≥ 1.85) and **Node.js**. That's it — `npm install` pulls `scan-engine` + `switch-input` from npm; no sibling checkout needed.
- **macOS:** switch capture happens in the webview by default (keys are captured when the window is focused and routed through the broker). No Accessibility permission needed. The broker's own system-wide grab is **disabled** — see "Capture" below.

## Run

```shell
npm install          # Tauri CLI + frontend deps
npm run tauri dev    # builds Rust + opens the window
```

The embedded broker serves `ws://127.0.0.1:7312`. Default mappings: `Space`/`Return`/`←`/`→` → `switch_1..4`. Tap an on-screen switch button — it calls `inject_switch` so it flows through the broker just like a physical key.

> Browser fallback: `npm run dev` (without Tauri) runs the same UI with a local `KeyboardAdapter` driving the scanner directly — handy for quick UI checks when no broker is present.

## Two tabs

**Scanner** — the scanning UI. Choose a mode (Scan items / Gliding cursor / Crosshair / Radar / Elimination), pick a strategy (row-column, linear, snake, quadrant), and scan. Switch events route through the broker. The USAHP routing panel controls the handoff mode (Focus / Always / Released) and shows capture state + broker activity (dwell times, events/min, live event stream).

**USAHP Manager** — broker admin + output routing:
- **Daemon status**: running, port, capture state, registered switches.
- **Switch editor**: add/remove/edit key → switch_id mappings at runtime (up to 8). Click a key cell and press a key to register it.
- **Failsafe config**: heartbeat interval, missed limit, escape hold, arbitration timeout (some future).
- **Session log**: timestamped handshake/revocation events from the broker.
- **Output routing**: Keystroke mode (switch → OS keystroke for any app) or Grid 3 mode (switch → `SendNotifyMessageA`, Windows only, up to 8 switches).

## Capture

By default the app captures switch keys **in the webview** and routes them through the embedded broker. This needs window focus, not system-wide, but works everywhere with no permissions.

Set **`USAHP_GRAB=1`** to enable real system-wide capture:
- **macOS:** uses a native `CGEventTap` (`src-tauri/src/macos_capture.rs`) that reads only keycodes — no TextServices, no `rdev` trap. Requires Accessibility permission (grant it, then restart the app). Includes a runtime capture flag so focus changes can pause/resume capture.
- **Linux/Windows:** uses `usahp`'s `rdev`/`evdev` grab.

The focus-based handoff (exclusive_foreground from RFC §6.5.1) is wired: focus the app → it captures; click away → keys pass to the OS.

## Notes

- `usahp-{core,daemon}` are git deps pinned to a rev (see `src-tauri/Cargo.toml`). For local iteration against a checked-out usahp workspace, override with a `[patch]` or a local path.
- Embedded config: `src-tauri/resources/default-config.toml`.
- Cross-platform by construction (CGEventTap on macOS, rdev on Windows, evdev on Linux); verified on macOS so far.

## Related

- [USAHP specification](https://github.com/OwenMcGirr/usahp/docs/spec) — RFC + plain English
- [USAHP docs site](https://owenmcgirr.github.io/usahp/) — VitePress
- [scan-engine-lab](https://github.com/willwade/scan-engine-lab) — the scanning engine + `switch-input` npm packages
- [Build plan](https://github.com/AACTools/usahp-spec/blob/main/USAHP-Tauri-Demo-Build-Plan.md) — phased plan with decision log
