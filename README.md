# PerfMon OBS Overlay

## A Vibecode Project

A sleek, ultra-lightweight hardware monitoring overlay for streamers and gamers. Built with **Tauri v2**, **Rust**, and **Vanilla Web technologies**, it reads telemetry directly from **LibreHardwareMonitor** (for CPU/GPU/RAM) and **RTSS (RivaTuner Statistics Server)** (for FPS) to display real-time metrics.

Zero Python runtimes, zero complex setups, zero external network dependencies.

---

## Features

- **Direct Hardware & FPS Telemetry:**
  - **Hardware Sensors:** Reads CPU, GPU, RAM, VRAM, and Power telemetry seamlessly via **LibreHardwareMonitor**'s local web server API.
  - **Framerate Tracking:** Reads FPS and frametimes via direct low-level Win32 Shared Memory from **RTSS** (`RTSSSharedMemoryV2`).
- **Dynamic Hardware Detection:** Automatically detects CPU model and GPU brand/VRAM directly from the Windows Registry and LHM.
- **Vendor-Themed Aesthetics:** Intelligently color-codes metrics based on hardware vendor:
  - **Intel:** Radiant Blue
  - **AMD:** Crimson Red
  - **NVIDIA:** Neon Green
  - **RAM:** Electric Purple
  - **FPS:** Gold Yellow
- **Multiple Layout Themes:** Switch between a modern vertical "Default" stack, or the compact horizontal "Classic" layout.
- **Window Management & Drag Protection:**
  - Dragging the overlay is strictly restricted to holding the floating **Settings button (`⚙`)**, preventing accidental moves during stream or gaming sessions.
- **Click-Through & Right-Alt Bypass:**
  - **Click-Through Mode:** Pass all mouse clicks through the overlay to underlying games and applications.
  - **Right-Alt Quick Bypass:** While Click-Through is active, holding down **Right-Alt** temporarily restores mouse interactivity with an ambient cyan glow.
- **Proportional Corner-Only Scaling:**
  - Side borders are blocked from resizing at the Win32 OS level (`WM_NCHITTEST`).
  - Resizing from any of the 4 corner handles smoothly scales the entire layout uniformly using dynamic Win32 aspect ratio locking (`WM_SIZING`).
- **Adaptive Height & Safeguards:**
  - Toggling display cards (CPU, GPU, RAM, FPS) dynamically shrinks or expands the window height.
  - Automatically enforces a minimum of 1 active monitor card so the window can never be accidentally hidden or lost.
- **Window State Persistence:** Scale factor, window position, card visibility, theme, and Always-on-Top states are saved across sessions.

---

## Requirements

1. **Windows 10 / 11 (64-bit)**
2. **LibreHardwareMonitor** (Must be running with the Web Server enabled on port 8085)
3. **RTSS (RivaTuner Statistics Server)** (Must be running for FPS and Frametime metrics)

---

## Setup with OBS Studio

1. Launch **LibreHardwareMonitor** and install the PawnIO if there is pop up (Ensure Options -> Web Server -> Run is checked).
2. Launch **RTSS**.
3. Launch **PerfMon OBS**.
4. In **OBS Studio**, add a new **Window Capture** source to your scene.
5. Set the window to: `[perfmon-obs.exe]: PerfMon OBS`.
6. Capture Method: **Windows 10 (1903 and up)**.
7. The transparent background and rounded widget will composite cleanly over your gameplay or stream layout.

---

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/) (stable toolchain)

### Run in Development Mode

```powershell
# Install frontend dependencies
npm install

# Start development overlay with live-reload
npm run tauri dev
```

### Build Standalone Production Executable

```powershell
npm run tauri build
```

The compiled, standalone `.exe` and installers will be generated in:

```
src-tauri/target/release/
```

---

## About Usage

- **Settings:** Click the `⚙` button to control how many parameters show, the theme, and how the window acts.
- **Always on top:** If checked, the window will always be on top of all other windows.
- **Click through:** If checked, the window will pass all mouse clicks through to the underlying applications. To bypass this temporarily and interact with the overlay settings, hold the **Right Alt** key.

## License

MIT License. Open-source and free for personal, streaming, and commercial use.
