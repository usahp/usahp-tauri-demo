# usahp-tauri-demo

A cross-platform desktop demo that embeds the [USAHP](https://github.com/OwenMcGirr/usahp) v0 switch-event broker **in-process** inside a [Tauri 2](https://tauri.app) app, with a switch-scanner webview built on the published [`scan-engine`](https://www.npmjs.com/package/scan-engine) + [`switch-input`](https://www.npmjs.com/package/switch-input) packages.

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

## Prerequisites

- **Rust** (≥ 1.85) and **Node.js**. That's it — `npm install` pulls `scan-engine` + `switch-input` from npm; no sibling checkout needed.
- **macOS:** the keyboard switch grab uses a global hook (`rdev`). Grant **Accessibility** to the app binary (System Settings → Privacy → Accessibility) for capture to work; without it the grab is inert (keys pass through to the OS) but the broker still serves.

## Run

```shell
npm install          # Tauri CLI + frontend deps (scan-engine, switch-input)
npm run tauri dev    # builds Rust + opens the window
```

The embedded broker serves `ws://127.0.0.1:7312`. Default mappings: `Space`/`Return`/`←`/`→` → `switch_1..4` (select/step/reset/cancel; roles reassignable in the UI). Tap an on-screen Sw button — it calls `inject_switch` so it flows through the broker just like a physical key.

> Browser fallback: `npm run dev` (without Tauri) runs the same UI with a local `KeyboardAdapter` driving the scanner directly — handy for quick UI checks when no broker is present.

## Status

- ✅ **Broker embedded** and verified in-process — the app serves `hello` on `:7312` at launch.
- ✅ **Frontend routed through the broker** — physical keys (global grab) and on-screen buttons (`inject_switch`) both flow through USAHP to the scanner.
- ⏳ Analog/confidence inputs ride on [OwenMcGirr/usahp#3](https://github.com/OwenMcGirr/usahp/pull/3); this repo pins a pre-confidence rev of `usahp` and bumps after that merges.

## Notes

- `usahp-{core,daemon}` are git deps pinned to a rev (see `src-tauri/Cargo.toml`). For local iteration against a checked-out usahp workspace, override with a `[patch]` or a local path.
- Embedded config: `src-tauri/resources/default-config.toml`. Live key remapping isn't supported under the global grab (`rdev` can't restart) — keys are fixed there; the UI reassigns *roles*. Arbitrary-key remap is a future usahp reconfigure feature.
- Capture is cross-platform by construction (rdev on macOS/Windows, evdev on Linux); verified on macOS so far. Windows/Linux need their per-platform input permission at runtime.
