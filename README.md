# PerfMon OBS Overlay
## A Vibecode Project

A sleek, ultra-lightweight hardware monitoring overlay for streamers and gamers. Built with **Tauri v2**, **Rust**, and **Vanilla Web technologies**, it reads telemetry directly from **MSI Afterburner** and **RTSS (RivaTuner Statistics Server)** via low-level Win32 shared memory to display real-time CPU, GPU, RAM, and FPS metrics.

Zero Python runtimes, zero local web servers, zero external network dependencies.

---

## Features

- **Direct Win32 Shared Memory Access:** Reads hardware telemetry at low CPU overhead directly from MSI Afterburner (`MAHMSharedMemory.h`) and RTSS (`RTSSSharedMemory.h`).
- **Dynamic Hardware Detection:** Automatically detects CPU model and GPU brand/VRAM directly from the Windows Registry and Afterburner.
- **Vendor-Themed Aesthetics:** Intelligently color-codes metrics based on hardware vendor:
  - **Intel:** Radiant Blue
  - **AMD:** Crimson Red
  - **NVIDIA:** Neon Green
  - **RAM:** Electric Purple
  - **FPS:** Gold Yellow
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
- **Window State Persistence:** Scale factor, window position, card visibility, and Always-on-Top states are saved across sessions.

---

## Requirements

1. **Windows 10 / 11 (64-bit)**
2. **MSI Afterburner** (must be running in the background for CPU/GPU/RAM metrics)
3. **RTSS (RivaTuner Statistics Server)** (required for FPS and Frametime metrics)

---

## Setup with OBS Studio

1. Launch **MSI Afterburner**.
2. Launch **PerfMon OBS**.
3. In **OBS Studio**, add a new **Window Capture** source to your scene.
4. Set the window to: `[perfmon-obs.exe]: PerfMon OBS`.
5. Capture Method: **Windows 10 (1903 and up)**.
6. The transparent background and rounded widget will composite cleanly over your gameplay or stream layout.

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

-- There will be a settings button to controll how much parameter show and about how the window act.

-- If you checked "Always on top", the window will always be on top of all the other windows.

-- If you checked "Click through", the window will pass all mouse clicks through to the underlying applications and to click through you can bypass by holding right alt and use the mouse to interact with the window.

## License

MIT License. Open-source and free for personal, streaming, and commercial use.