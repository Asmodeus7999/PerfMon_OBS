/**
 * sensors.js — listens for sensor-update / sensor-error events from the Rust
 * backend and renders the values into the skeleton built by modules/skeleton.js.
 *
 * The sensor data structure emitted from Rust (SensorPayload) is intentionally
 * compatible with the old JSON format so the parsing logic is unchanged:
 *   payload.sensors        — array of SensorEntry  (same fields as Python)
 *   payload.system_info    — { cpu_name, ram_gb, gpus: [{device, vram_gb}] }
 *   payload.fps            — { fps, frame_time_ms } | null  (new from RTSS)
 */
import { listen } from '@tauri-apps/api/event';
import { dom, state, SRC } from './state.js';
import {
    buildSkeleton, setStat, setFpsStat, getThemeClass, applyTheme,
    shortCpuName, shortGpuName, setSubtitleIfChanged,
} from './skeleton.js';

function findBySrcId(data, srcId, gpuIndex = null) {
    return data.find(e => {
        if (e.srcId !== srcId) return false;
        if (gpuIndex !== null && e.gpu !== 0xFFFFFFFF && e.gpu !== gpuIndex) return false;
        return true;
    }) || null;
}

function findByName(sensors, name) {
    const lower = name.toLowerCase();
    return sensors.find(e => e.name && e.name.toLowerCase().includes(lower)) || null;
}

export function initSensors() {
    // ── Initial state: show loading while Rust backend starts polling ─────────
    dom.container.innerHTML = `
        <div class="loading">
            <div class="spinner"></div>
            Waiting for sensor data...
        </div>`;

    listen('sensor-update', (event) => {
        const payload = event.payload;
        const data    = payload.sensors ?? payload;

        if (!state.built) buildSkeleton();

        const GPU = 0;

        // System info
        const sysInfo  = payload.system_info ?? {};
        const gpuEntry = (sysInfo.gpus ?? [])[GPU] ?? {};

        const cpuLabel  = sysInfo.cpu_name ?? 'CPU';
        const gpuLabel  = gpuEntry.device  ?? 'GPU';
        const ramTotal  = sysInfo.ram_gb   != null ? `${sysInfo.ram_gb} GB` : '';
        const vramTotal = gpuEntry.vram_gb != null ? `${gpuEntry.vram_gb} GB VRAM` : '';

        setSubtitleIfChanged(state.els.cpuShort, shortCpuName(cpuLabel));
        setSubtitleIfChanged(state.els.gpuShort, shortGpuName(gpuLabel));
        setSubtitleIfChanged(state.els.cpuSubtitle, cpuLabel);
        setSubtitleIfChanged(state.els.gpuSubtitle, gpuLabel);
        setSubtitleIfChanged(state.els.ramSubtitle, [ramTotal, vramTotal].filter(Boolean).join(' · '));

        applyTheme(state.els.cpuCard, getThemeClass(cpuLabel));
        applyTheme(state.els.gpuCard, getThemeClass(gpuLabel));

        // Sensor values
        setStat('cpu-temp',  findBySrcId(data, SRC.CPU_TEMPERATURE));
        setStat('cpu-load',  findBySrcId(data, SRC.CPU_USAGE));
        setStat('cpu-power', findBySrcId(data, SRC.CPU_POWER));
        setStat('cpu-clock', findBySrcId(data, SRC.CPU_CLOCK));

        setStat('gpu-temp',  findBySrcId(data, SRC.GPU_TEMPERATURE, GPU));
        setStat('gpu-load',  findBySrcId(data, SRC.GPU_USAGE,       GPU));
        setStat('gpu-power', findBySrcId(data, SRC.GPU_ABS_POWER,   GPU));
        setStat('gpu-clock', findBySrcId(data, SRC.CORE_CLOCK,      GPU));

        const ramUsage = findBySrcId(data, SRC.RAM_USAGE);
        setStat('ram-usage',  ramUsage, ramUsage?.units ?? 'MB');
        setStat('vram-usage', findBySrcId(data, SRC.MEMORY_USAGE, GPU));

        // FPS from RTSS or Afterburner sensor fallback
        let fpsVal   = payload.fps?.fps;
        let ftimeVal = payload.fps?.frame_time_ms;

        if (fpsVal == null || fpsVal <= 0) {
            const fpsEntry = findByName(data, 'framerate');
            if (fpsEntry && fpsEntry.value != null && fpsEntry.value > 0) fpsVal = fpsEntry.value;
        }
        if (ftimeVal == null || ftimeVal <= 0) {
            const ftimeEntry = findByName(data, 'frametime');
            if (ftimeEntry && ftimeEntry.value != null && ftimeEntry.value > 0) ftimeVal = ftimeEntry.value;
        }

        setFpsStat('fps',   fpsVal,   0);
        setFpsStat('ftime', ftimeVal, state.currentTheme === 'classic' ? 1 : 2);

    }).catch(err => console.error('Failed to listen to sensor-update:', err));

    listen('sensor-error', (event) => {
        state.built = false;
        dom.container.innerHTML = `
            <div class="loading">
                <div class="spinner"></div>
                ${event.payload}
            </div>`;
    }).catch(err => console.error('Failed to listen to sensor-error:', err));
}
