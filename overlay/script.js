const ws = new WebSocket('ws://localhost:8765');
const container = document.getElementById('osd-container');

// Source IDs from MSI Afterburner SDK (MAHMSharedMemory.h)
const SRC = {
    GPU_TEMPERATURE: 0x00,   // °C
    CORE_CLOCK:      0x20,   // MHz  — GPU core clock
    GPU_USAGE:       0x30,   // %
    MEMORY_USAGE:    0x31,   // MB   — GPU memory used (VRAM)
    GPU_ABS_POWER:   0x61,   // W
    CPU_TEMPERATURE: 0x80,   // °C
    CPU_USAGE:       0x90,   // %
    RAM_USAGE:       0x91,   // MB or %
    CPU_CLOCK:       0xA0,   // MHz
    CPU_POWER:       0x100,  // W
};

function findBySrcId(data, srcId, gpuIndex = null) {
    return data.find(e => {
        if (e.srcId !== srcId) return false;
        if (gpuIndex !== null && e.gpu !== 0xFFFFFFFF && e.gpu !== gpuIndex) return false;
        return true;
    }) || null;
}

// Render a fixed-size stat box
// widthClass: 'sw-2d' | 'sw-3d' | 'sw-4d' | 'sw-5d'
function statBox(entry, unit, label, widthClass) {
    const v = (entry && entry.value !== null && entry.value !== undefined)
        ? Math.round(entry.value)
        : null;
    const dim = v === null ? ' style="opacity:0.2"' : '';
    return `
        <div class="stat-box ${widthClass}"${dim}>
            <div class="stat-val-row">
                <span class="stat-val">${v !== null ? v : '–'}</span>
                <span class="stat-unit">${unit}</span>
            </div>
            <span class="stat-label">${label}</span>
        </div>`;
}

ws.onopen = () => {
    container.innerHTML = `
        <div class="loading">
            <div class="spinner"></div>
            Connected. Waiting for data...
        </div>`;
};

ws.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    const data    = payload.sensors ?? payload;

    if (payload.error) {
        container.innerHTML = `<div class="loading">${payload.error}</div>`;
        return;
    }

    const GPU = 0;

    // --- System Info (hardware names / memory totals) ---
    const sysInfo  = payload.system_info ?? {};
    const gpuEntry = (sysInfo.gpus ?? [])[GPU] ?? {};

    const cpuLabel  = sysInfo.cpu_name  ?? 'CPU';
    const gpuLabel  = gpuEntry.device   ?? 'GPU';
    const ramTotal  = sysInfo.ram_gb    != null ? `${sysInfo.ram_gb} GB` : '';
    const vramTotal = gpuEntry.vram_gb  != null ? `${gpuEntry.vram_gb} GB VRAM` : '';
    const ramSubtitle = [ramTotal, vramTotal].filter(Boolean).join(' · ');

    // Sensors
    const cpuTemp  = findBySrcId(data, SRC.CPU_TEMPERATURE);
    const cpuUsage = findBySrcId(data, SRC.CPU_USAGE);
    const cpuPower = findBySrcId(data, SRC.CPU_POWER);
    const cpuClock = findBySrcId(data, SRC.CPU_CLOCK);

    const gpuTemp  = findBySrcId(data, SRC.GPU_TEMPERATURE, GPU);
    const gpuUsage = findBySrcId(data, SRC.GPU_USAGE, GPU);
    const gpuPower = findBySrcId(data, SRC.GPU_ABS_POWER, GPU);
    const gpuClock = findBySrcId(data, SRC.CORE_CLOCK, GPU);

    const ramUsage = findBySrcId(data, SRC.RAM_USAGE);
    const vramUsed = findBySrcId(data, SRC.MEMORY_USAGE, GPU);

    // RAM unit (Afterburner can report % or MB)
    const ramUnit = ramUsage?.units ?? 'MB';

    function getThemeClass(label) {
        const l = (label || '').toLowerCase();
        if (l.includes('intel') || l.includes('arc')) return 'theme-intel';
        if (l.includes('amd') || l.includes('radeon') || l.includes('ryzen')) return 'theme-amd';
        if (l.includes('nvidia') || l.includes('geforce') || l.includes('rtx') || l.includes('gtx')) return 'theme-nvidia';
        return 'theme-default';
    }

    const cpuTheme = getThemeClass(cpuLabel);
    const gpuTheme = getThemeClass(gpuLabel);

    container.innerHTML = `

        <!-- CPU Card: Temp(3d) · Load(3d) · Power(3d) · Clock(4d) -->
        <div class="card card-cpu ${cpuTheme}">
            <div class="card-header">
                <div class="card-dot themed-dot"></div>
                <span class="card-name themed-color">CPU</span>
                <span class="card-subtitle">${cpuLabel}</span>
            </div>
            <div class="stats-row">
                ${statBox(cpuTemp,  '°C',  'Temp',  'sw-3d')}
                ${statBox(cpuUsage, '%',   'Load',  'sw-3d')}
                ${statBox(cpuPower, 'W',   'Power', 'sw-3d')}
                ${statBox(cpuClock, 'MHz', 'Clock', 'sw-4d')}
            </div>
        </div>

        <!-- GPU Card: Temp(3d) · Load(3d) · Power(3d) · Clock(4d) -->
        <div class="card card-gpu ${gpuTheme}">
            <div class="card-header">
                <div class="card-dot themed-dot"></div>
                <span class="card-name themed-color">GPU</span>
                <span class="card-subtitle">${gpuLabel}</span>
            </div>
            <div class="stats-row">
                ${statBox(gpuTemp,  '°C',  'Temp',  'sw-3d')}
                ${statBox(gpuUsage, '%',   'Load',  'sw-3d')}
                ${statBox(gpuPower, 'W',   'Power', 'sw-3d')}
                ${statBox(gpuClock, 'MHz', 'Clock', 'sw-4d')}
            </div>
        </div>

        <!-- RAM Card: RAM Used(5d) · VRAM Used(5d) -->
        <div class="card card-ram">
            <div class="card-header">
                <div class="card-dot ram-dot"></div>
                <span class="card-name ram-color">RAM</span>
                <span class="card-subtitle">${ramSubtitle}</span>
            </div>
            <div class="stats-row">
                ${statBox(ramUsage, ramUnit, 'System RAM', 'sw-5d')}
                ${statBox(vramUsed, 'MB',    'VRAM',       'sw-5d')}
            </div>
        </div>
    `;
};

ws.onclose = () => {
    container.innerHTML = `
        <div class="loading">
            <div class="spinner"></div>
            Connection lost. Reconnecting...
        </div>`;
    setTimeout(() => location.reload(), 5000);
};

ws.onerror = (error) => {
    console.error('WebSocket Error:', error);
};
