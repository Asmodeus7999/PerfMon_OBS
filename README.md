# PerfMon OBS Overlay

A sleek, real-time performance monitoring overlay designed for OBS Studio. Built with Python and WebSockets, this tool securely reads hardware telemetry directly from MSI Afterburner and RTSS to display CPU, GPU, Memory, and FPS metrics in a beautifully styled, transparent web widget.

## Features
* **Direct Shared Memory Access:** Uses Windows API (`ctypes`) to read local sensor data from MSI Afterburner and RTSS without requiring external APIs.
* **Dynamic Hardware Detection:** Automatically fetches your exact CPU and GPU names directly from Windows and Afterburner.
* **Auto-Theming UI:** The overlay intelligently color-codes the UI based on your hardware vendor (Intel = Blue, AMD = Red, NVIDIA = Green).
* **OBS-Ready UI:** Features a transparent background, glassmorphism blur effects, and dynamic data binding perfect for a Browser Source overlay.
* **Zero-Impact Backend:** The Python WebSocket server automatically runs at `BELOW_NORMAL` process priority and disables Core 0 usage to ensure it never causes game stutters.
* **Comprehensive Metrics:** Tracks CPU/GPU temperatures, utilization, power draw, clock speeds, system RAM, VRAM, Framerate (FPS), and Frametime (ms).

## Requirements
To use this overlay, you must have the following installed and running on your Windows machine:
1. **MSI Afterburner** (Must be actively running in the background for hardware stats)
2. **RTSS (RivaTuner Statistics Server)** (Optional: Must be actively running for FPS and Frametime stats)

## Installation & Setup

### Option 1: Using the Release (No Python Required)
1. Download the latest `PerfMon_Release.zip` from the Releases page.
2. Extract the folder anywhere on your PC.
3. Run `PerfMonServer.exe` to start the backend server.
4. In OBS, add a **Browser Source**, check **"Local file"**, and point it to `overlay/index.html` inside the extracted folder. Set width/height to your preference.

### Option 2: Running from Source
1. **Clone the repository:**
    ```bash
    git clone https://github.com/yourusername/perfmon-obs-overlay.git
    cd perfmon-obs-overlay
    ```

2. **Install Python dependencies:**
    The backend relies on the `websockets` library. Install it via pip:
    ```bash
    pip install websockets
    ```

3. **Start the WebSocket Server:**
    Run the script manually from your terminal:
    ```bash
    python afterburner_server.py
    ```

4. **Add to OBS Studio:**
    * Add a new **Browser Source** in your OBS scene.
    * Check the **"Local file"** box.
    * Click **Browse** and select the `index.html` file located inside the `overlay/` folder.
    * Set your desired Width and Height (e.g., Width: 420, Height: 420).
    * Leave the background transparent.

## Building the Release
If you want to package the project into a standalone executable:
```bash
pip install pyinstaller
pyinstaller server.spec --clean --noconfirm
```
This will generate the built server and include the `overlay/` folder automatically in `dist/PerfMonServer/`. You can zip this folder to distribute it!