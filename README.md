# usahp-tauri-demo

A cross-platform desktop demo that embeds the [USAHP](../switch-interface) v0 switch-event broker **in-process** inside a [Tauri 2](https://tauri.app) app, with the [scan-engine-lab](../garyd-scanner-demo) switch scanner as the webview frontend.

> Proves the chain end to end: **physical switch → embedded Rust broker → loopback WebSocket → scanner UI**, with no separate daemon binary to install.

## Architecture

```
┌──────────────────────── Tauri app (one process) ────────────────────────┐
│                                                                         │
│  Rust backend (src-tauri)                  Webview frontend              │
│  ┌──────────────────────────────┐          ┌──────────────────────────┐ │
│  │ usahp-daemon (embedded)       │  WS      │ scan-engine-lab          │ │
│  │  ├─ broker (state machine)    │◄─────────│  └─ (UsahpAdapter: P5)   │ │
│  │  ├─ input (rdev/evdev grab)   │  127.0.0 │                          │ │
│  │  └─ server (WebSocket :7312)  │  .1:7312 │                          │ │
│  └──────────────────────────────┘          └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

The `setup` hook replays `usahpd`'s `main` on Tauri's async runtime: parse the embedded config → spawn the broker → spawn OS input capture → bind the loopback WebSocket → serve. The webview loads scan-engine-lab's built `dist/`.

## Prerequisites

- **Rust** (≥ 1.85; edition 2024 for the usahp crates) and **Node.js**.
- **scan-engine-lab checked out as a sibling** — the frontend points at `../garyd-scanner-demo/dist`. Clone `https://github.com/willwade/scan-engine-lab` next to this repo and build it once: `npm install && npm run build`.
- **macOS:** the keyboard switch grab uses a global hook (`rdev`). Grant **Accessibility** permission to the app binary (System Settings → Privacy → Accessibility) for capture to work; without it the grab is inert and keys pass through to the OS, but the broker still serves.

## Run

```shell
npm install                 # Tauri CLI
npm run tauri dev           # builds Rust + opens the window
```

The window loads scan-engine-lab; the Rust backend serves the broker at `ws://127.0.0.1:7312`. Confirm the broker is live with the reference listener from the usahp repo: `cargo run -p usahp-listen`.

## Status

- **Phase 4 (this repo):** broker embedded and verified in-process — the app serves `hello` on `:7312` on launch.
- **Phase 5 (pending):** wire scan-engine-lab's `UsahpAdapter` to the in-process broker and add a keyboard/USAHP source toggle.
- Analog/confidence inputs ride on [OwenMcGirr/usahp#3](https://github.com/OwenMcGirr/usahp/pull/3); this repo pins a pre-confidence rev of `usahp` and bumps after that merges.

## Notes

- `usahp-{core,daemon}` are git deps pinned to a rev (see `src-tauri/Cargo.toml`). For local iteration against a checked-out usahp workspace, override with a `[patch]` or a local path.
- The embedded config lives at `src-tauri/resources/default-config.toml` (maps `Space`/`Return` → `switch_1`). When Accessibility is granted, those keys are grabbed system-wide while the app runs.
