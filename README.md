# PerfMon OBS Overlay

A sleek, real-time performance monitoring overlay designed for OBS Studio. Built with Python and WebSockets, this tool securely reads hardware telemetry directly from MSI Afterburner and RTSS to display CPU, GPU, Memory, and FPS metrics in a beautifully styled, transparent web widget.

## Features
* **Direct Shared Memory Access:** Uses Windows API (`ctypes`) to read local sensor data from MSI Afterburner and RTSS without requiring external APIs.
* **OBS-Ready UI:** Features a transparent background, glassmorphism blur effects, and dynamic data binding perfect for a Browser Source overlay.
* **Zero-Impact Backend:** The Python WebSocket server automatically runs at `BELOW_NORMAL` process priority to ensure it never causes game stutters.
* **Comprehensive Metrics:** Tracks CPU/GPU temperatures, utilization, power draw, clock speeds, system RAM, VRAM, Framerate (FPS), and Frametime (ms).

## Requirements
To use this overlay, you must have the following installed and running on your Windows machine:
1. **Python 3.7+**
2. **MSI Afterburner** (Must be actively running in the background for hardware stats)
3. **RTSS (RivaTuner Statistics Server)** (Must be actively running for FPS and Frametime stats)

## Installation & Setup

1. **Clone the repository:**
    ```bash
    git clone [https://github.com/yourusername/perfmon-obs-overlay.git](https://github.com/yourusername/perfmon-obs-overlay.git)
    cd perfmon-obs-overlay
    ```

2. **Install Python dependencies:**
    The backend relies on the `websockets` library. Install it via pip:
    ```bash
    pip install websockets
    ```

3. **Start the WebSocket Server:**
    Double-click the `Start.bat` file, or run the script manually from your terminal:
    ```bash
    python afterburner_server.py
    ```
    The server will start running on `ws://localhost:8765`.

4. **Add to OBS Studio:**
    * Add a new **Browser Source** in your OBS scene.
    * Check the **"Local file"** box.
    * Click **Browse** and select the `index.html` file located inside the `overlay/` folder.
    * Set your desired Width and Height (e.g., Width: 700, Height: 210).
    * Leave the background transparent.

## Customization
By default, the overlay uses text labels for the CPU and GPU to look clean on stream. If you want to change the hardware names to match your specific rig:
1. Open `overlay/script.js` in any text editor.
2. Locate the HTML injection block (around line 60).
3. Change `"i5-4690"` and `"RX 580"` to your actual CPU and GPU names, also other parameter you can change the text there.
4. You can change the color of specs text in `style.css` file (arround line 63).
5. Save the file and refresh your OBS Browser Source.