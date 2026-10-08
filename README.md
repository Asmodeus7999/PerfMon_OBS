# PerfMon OBS Overlay

## A Vibecode Project

A sleek, ultra-lightweight hardware monitoring overlay for streamers and gamers. Built with **Tauri v2**, **Rust**, and **Vanilla Web technologies**.

Real-time hardware metrics are powered by two embedded sidecars that launch automatically with the app — no third-party software required:

- **LibreHardwareMonitor** (LHM) sidecar — CPU, GPU, RAM, Power telemetry
- **Intel PresentMon** — FPS and frametime via Windows ETW (passive, injection-free)

Zero Python runtimes. Zero external network dependencies. No RTSS. No standalone LHM.

---

## Features

- **Fully Embedded Telemetry — No Third-Party Apps Required:**
  - **Hardware Sensors:** CPU temp/load, GPU temp/load/VRAM, RAM usage, Power draw via an embedded **LibreHardwareMonitor** sidecar.
  - **Framerate Tracking:** FPS and frametime via **Intel PresentMon** using Windows ETW — completely passive, no process injection. Safe with all anti-cheats (Vanguard, EAC, BattlEye).
  - **Automatic Game Detection:** Tracks every presenting process and locks onto the one in the foreground (FPS only breaks ties), switching after about a second if you change games. A small built-in list ignores shell and launcher processes.
- **OBS Compatible:** Uses `--use-angle=swiftshader` renderer to prevent OBS Game Capture black-screen issues.
- **Dynamic Hardware Detection:** Auto-detects CPU model, GPU brand, and VRAM at startup.
- **Vendor-Themed Aesthetics:** Color-codes metrics by hardware vendor:
  - **Intel:** Radiant Blue
  - **AMD:** Crimson Red
  - **NVIDIA:** Neon Green
  - **RAM:** Electric Purple
  - **FPS:** Gold Yellow
- **Multiple Layout Themes:** Switch between a modern vertical "Default" stack or the compact horizontal "Classic" layout.
- **Click-Through & Right-Alt Bypass:**
  - **Click-Through Mode:** Pass all mouse clicks through the overlay to underlying games.
  - **Right-Alt Quick Bypass:** While Click-Through is active, hold **Right Alt** to temporarily restore mouse interaction.
- **Proportional Corner-Only Scaling:** Resize only from corners to maintain aspect ratio. Side borders are locked at the Win32 level.
- **Adaptive Height:** Toggling display cards (CPU, GPU, RAM, FPS) dynamically shrinks or expands the window.
- **Window State Persistence:** Scale, position, card visibility, theme, and Always-on-Top state are saved across sessions.

---

## Requirements

1. **Windows 10 / 11 (64-bit)**
2. **Run as Administrator** — required for LibreHardwareMonitor hardware sensor access and Intel PresentMon ETW tracing.

That's it. No RTSS. No standalone LibreHardwareMonitor. Everything is bundled.

---

## Setup with OBS Studio

1. Launch **PerfMon OBS** as Administrator.
2. In **OBS Studio**, add a new **Window Capture** source to your scene.
3. Set the window to: `[perfmon-obs.exe]: PerfMon OBS`.
4. Capture Method: **Windows 10 (1903 and up)**.
5. The transparent background and rounded widget will composite cleanly over your gameplay or stream layout.

---

## Usage

- **Settings (`⚙`):** Toggle which metrics show (CPU, GPU, RAM, FPS), change the theme, and control window behavior.
- **Always on Top:** Keeps the overlay above all other windows including fullscreen games (windowed/borderless).
- **Click Through:** Passes all mouse input through to the game. Hold **Right Alt** to temporarily interact with the overlay without disabling click-through.

---

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/) (stable toolchain, `x86_64-pc-windows-msvc`)
- [.NET 9 SDK](https://dotnet.microsoft.com/download/dotnet/9.0) — for the LHM sidecar

### Run in Development Mode

```powershell
# Install frontend dependencies
npm install

# Build the LHM sidecar (only needed once, or after sidecar changes)
npm run build:sidecar

# Start development overlay with live-reload
npm run tauri dev
```

### Build Production Installer

```powershell
npm run tauri build
```

The sidecar is built automatically before the production build. The NSIS installer and standalone `.exe` are generated at:

```
src-tauri/target/release/bundle/nsis/
src-tauri/target/release/perfmon-obs.exe
```

### Other Scripts

| Command                 | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `npm run build:sidecar` | Build & deploy LHM sidecar to Tauri target dirs         |
| `npm run portable`      | Package a portable ZIP (no installer)                   |
| `npm run clean`         | Delete build artifacts (dist, Rust target, .NET output) |

---

## Architecture

```
perfmon-obs.exe  (Tauri v2 + Rust)
├── lhm-sidecar.exe   (.NET 9, LibreHardwareMonitorLib — hardware sensors)
└── PresentMon-x64.exe  (Intel PresentMon — FPS via ETW)
```

Both sidecars are launched as child processes at startup and killed automatically when the overlay closes.

---

## License

MIT License. Open-source and free for personal, streaming, and commercial use.
