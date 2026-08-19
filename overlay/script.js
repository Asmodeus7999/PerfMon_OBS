const ws = new WebSocket('ws://localhost:8765');
const container = document.getElementById('osd-container');
const fpsPanel  = document.getElementById('fps-panel');

// Source IDs from MSI Afterburner SDK (MAHMSharedMemory.h)
const SRC = {
    GPU_TEMPERATURE: 0x00,   // °C
    CORE_CLOCK: 0x20,   // MHz  — GPU core clock
    MEMORY_CLOCK: 0x22,   // MHz  — GPU memory clock
    GPU_USAGE: 0x30,   // %
    MEMORY_USAGE: 0x31,   // MB   — GPU memory used ("Memory usage" in Afterburner)
    FB_USAGE: 0x32,   // %    — framebuffer controller usage (percentage, NOT MB)
    GPU_ABS_POWER: 0x61,   // W    — absolute GPU power
    CPU_TEMPERATURE: 0x80,   // °C
    CPU_USAGE: 0x90,   // %
    RAM_USAGE: 0x91,   // % or MB — system RAM
    CPU_CLOCK: 0xA0,   // MHz
    CPU_POWER: 0x100,  // W
};

// Find the first entry matching the given srcId.
// gpuIndex: pass 0 (or any GPU index) to restrict to that GPU, or null for global/any.
function findBySrcId(data, srcId, gpuIndex = null) {
    return data.find(e => {
        if (e.srcId !== srcId) return false;
        if (gpuIndex !== null && e.gpu !== 0xFFFFFFFF && e.gpu !== gpuIndex) return false;
        return true;
    }) || null;
}

// Find a sensor entry by its display name (case-insensitive, partial match OK)
function findByName(data, name) {
    const lower = name.toLowerCase();
    return data.find(e => e.name.toLowerCase().includes(lower)) || null;
}

function renderStatBox(entry, overrideUnit = null, extraClass = "") {
    if (!entry || entry.value === null) {
        return `<div class="stat-box ${extraClass}" style="opacity: 0.2"><span class="stat-val">-</span></div>`;
    }
    const displayUnit = overrideUnit !== null ? overrideUnit : entry.units;
    return `
        <div class="stat-box ${extraClass}">
            <span class="stat-val">${Math.round(entry.value)}</span>
            <span class="stat-unit">${displayUnit}</span>
        </div>
    `;
}

ws.onopen = () => {
    container.innerHTML = `
        <div class="loading">
            <div class="spinner"></div>
            Connected. Waiting for data...
        </div>
    `;
};

ws.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    const data    = payload.sensors ?? payload;   // back-compat: plain array fallback

    if (payload.error) {
        container.innerHTML = `<div class="loading">${payload.error}</div>`;
        return;
    }

    // Primary GPU index (0 = first GPU, change if you have multiple GPUs)
    const GPU = 0;

    // --- GPU readings ---
    const gpuTemp = findBySrcId(data, SRC.GPU_TEMPERATURE, GPU);
    const gpuClock = findBySrcId(data, SRC.CORE_CLOCK, GPU);
    const gpuUsage = findBySrcId(data, SRC.GPU_USAGE, GPU);
    const gpuPower = findBySrcId(data, SRC.GPU_ABS_POWER, GPU);
    const vramUsed = findBySrcId(data, SRC.MEMORY_USAGE, GPU);  // "Memory usage" in MB

    // --- CPU / system readings (global, gpu = 0xFFFFFFFF) ---
    const cpuTemp = findBySrcId(data, SRC.CPU_TEMPERATURE);
    const cpuUsage = findBySrcId(data, SRC.CPU_USAGE);
    const cpuClock = findBySrcId(data, SRC.CPU_CLOCK);
    const cpuPower = findBySrcId(data, SRC.CPU_POWER);
    const ramUsage = findBySrcId(data, SRC.RAM_USAGE);

    let html = '';

    // Row 1: CPU
    html += `
        <div class="row">
            <div class="label-group">
                <span class="label-title cpu-color">i5-4690</span>
                <span class="label-subtitle">CPU</span>
            </div>
            <div class="stats-group">
                ${renderStatBox(cpuTemp, '°C', 'stat-temp')}
                ${renderStatBox(cpuUsage, '%', 'stat-usage')}
                ${renderStatBox(cpuPower, 'W', 'stat-power')}
                ${renderStatBox(cpuClock, 'MHz', 'stat-clock')}
            </div>
        </div>
    `;

    // Row 2: GPU
    html += `
        <div class="row">
            <div class="label-group">
                <span class="label-title gpu-color">RX 580</span>
                <span class="label-subtitle">GPU</span>
            </div>
            <div class="stats-group">
                ${renderStatBox(gpuTemp, '°C', 'stat-temp')}
                ${renderStatBox(gpuUsage, '%', 'stat-usage')}
                ${renderStatBox(gpuPower, 'W', 'stat-power')}
                ${renderStatBox(gpuClock, 'MHz', 'stat-clock')}
            </div>
        </div>
    `;

    // Row 3: Memory (RAM & VRAM)
    // RAM is shown in whatever unit Afterburner reports (% or MB)
    const ramLabel = ramUsage ? ramUsage.units : '%';
    html += `
        <div class="row">
            <div class="label-group">
                <span class="label-title ram-color">MEMORY</span>
                <span class="label-subtitle">16GB RAM & 4GB VRAM</span>
            </div>
            <div class="stats-group">
                ${renderStatBox(ramUsage, `${ramLabel} RAM`, 'stat-memory')}
                ${renderStatBox(vramUsed, 'MB VRAM', 'stat-memory')}
            </div>
        </div>
    `;

    container.innerHTML = html;

    // ── FPS side panel ── read directly from Afterburner sensor data
    const fpsEntry   = findByName(data, 'framerate');
    const ftimeEntry = findByName(data, 'frametime');

    const fpsVal   = fpsEntry?.value;
    const ftimeVal = ftimeEntry?.value;

    if (fpsVal !== null && fpsVal !== undefined && fpsVal > 0) {
        fpsPanel.innerHTML = `
            <div class="fps-main">
                <span class="fps-number">${Math.round(fpsVal)}</span>
                <span class="fps-unit">FPS</span>
            </div>
            <div class="fps-divider"></div>
            <div class="ftime-row">
                <span class="ftime-number">${ftimeVal !== null && ftimeVal !== undefined ? ftimeVal.toFixed(2) : '--'}</span>
                <span class="ftime-unit">ms / frame</span>
            </div>
        `;
    } else {
        fpsPanel.innerHTML = `<div class="fps-panel-idle">—</div>`;
    }
};


ws.onclose = () => {
    container.innerHTML = `
        <div class="loading">
            <div class="spinner"></div>
            Connection lost. Reconnecting...
        </div>
    `;
    setTimeout(() => {
        location.reload();
    }, 5000);
};

ws.onerror = (error) => {
    console.error("WebSocket Error:", error);
};
