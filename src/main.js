/**
 * main.js — PerfMon OBS Tauri frontend
 *
 * Adapted from overlay/script.js. Key changes:
 *   - WebSocket removed; replaced with Tauri event listeners (listen())
 *   - FPS / frametime card added (uses payload.fps from Rust backend)
 *   - Settings panel wired up (show/hide per-card, persisted in localStorage)
 *   - Keyboard shortcut: S → toggle settings panel
 *
 * The sensor data structure emitted from Rust (SensorPayload) is intentionally
 * compatible with the old JSON format so the parsing logic is unchanged:
 *   payload.sensors        — array of SensorEntry  (same fields as Python)
 *   payload.system_info    — { cpu_name, ram_gb, gpus: [{device, vram_gb}] }
 *   payload.fps            — { fps, frame_time_ms } | null  (new from RTSS)
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window';

// ── Tauri window handle ───────────────────────────────────────────────────────
const appWindow = getCurrentWindow();

// ── DOM refs ──────────────────────────────────────────────────────────────────
const container = document.getElementById('osd-container');

// Source IDs from MSI Afterburner SDK (MAHMSharedMemory.h) — unchanged from original
const SRC = {
    GPU_TEMPERATURE: 0x00,
    CORE_CLOCK:      0x20,
    GPU_USAGE:       0x30,
    MEMORY_USAGE:    0x31,
    GPU_ABS_POWER:   0x61,
    CPU_TEMPERATURE: 0x80,
    CPU_USAGE:       0x90,
    RAM_USAGE:       0x91,
    CPU_CLOCK:       0xA0,
    CPU_POWER:       0x100,
};

function findBySrcId(data, srcId, gpuIndex = null) {
    return data.find(e => {
        if (e.srcId !== srcId) return false;
        if (gpuIndex !== null && e.gpu !== 0xFFFFFFFF && e.gpu !== gpuIndex) return false;
        return true;
    }) || null;
}

// ── Static stat-box definitions ───────────────────────────────────────────────
const STAT_DEFS = [
    { id: 'cpu-temp',   unit: '°C',  label: 'Temp',       widthClass: 'sw-3d' },
    { id: 'cpu-load',   unit: '%',   label: 'Load',       widthClass: 'sw-3d' },
    { id: 'cpu-power',  unit: 'W',   label: 'Power',      widthClass: 'sw-3d' },
    { id: 'cpu-clock',  unit: 'MHz', label: 'Clock',      widthClass: 'sw-4d' },
    { id: 'gpu-temp',   unit: '°C',  label: 'Temp',       widthClass: 'sw-3d' },
    { id: 'gpu-load',   unit: '%',   label: 'Load',       widthClass: 'sw-3d' },
    { id: 'gpu-power',  unit: 'W',   label: 'Power',      widthClass: 'sw-3d' },
    { id: 'gpu-clock',  unit: 'MHz', label: 'Clock',      widthClass: 'sw-4d' },
    { id: 'ram-usage',  unit: 'MB',  label: 'System RAM', widthClass: 'sw-5d' },
    { id: 'vram-usage', unit: 'MB',  label: 'VRAM',       widthClass: 'sw-5d' },
    { id: 'fps',        unit: 'FPS', label: 'Framerate',  widthClass: 'sw-3d' },
    { id: 'ftime',      unit: 'ms',  label: 'Frametime',  widthClass: 'sw-4d' },
];

function statBoxSkeleton({ id, unit, label, widthClass }) {
    return `
        <div class="stat-box ${widthClass}" id="box-${id}">
            <div class="stat-val-row">
                <span class="stat-val" id="val-${id}">–</span>
                <span class="stat-unit" id="unit-${id}">${unit}</span>
            </div>
            <span class="stat-label">${label}</span>
        </div>`;
}

const byId = (id) => STAT_DEFS.find(s => s.id === id);

let built = false;
let els = {};

function buildSkeleton() {
    container.innerHTML = `
        <div class="osd-root">
            <div class="card card-cpu theme-default" id="card-cpu">
                <div class="card-header">
                    <div class="card-dot themed-dot"></div>
                    <span class="card-name themed-color">CPU</span>
                    <span class="card-subtitle" id="cpu-subtitle"></span>
                </div>
                <div class="stats-row">
                    ${statBoxSkeleton(byId('cpu-temp'))}
                    ${statBoxSkeleton(byId('cpu-load'))}
                    ${statBoxSkeleton(byId('cpu-power'))}
                    ${statBoxSkeleton(byId('cpu-clock'))}
                </div>
            </div>

            <div class="card card-gpu theme-default" id="card-gpu">
                <div class="card-header">
                    <div class="card-dot themed-dot"></div>
                    <span class="card-name themed-color">GPU</span>
                    <span class="card-subtitle" id="gpu-subtitle"></span>
                </div>
                <div class="stats-row">
                    ${statBoxSkeleton(byId('gpu-temp'))}
                    ${statBoxSkeleton(byId('gpu-load'))}
                    ${statBoxSkeleton(byId('gpu-power'))}
                    ${statBoxSkeleton(byId('gpu-clock'))}
                </div>
            </div>

            <div class="card card-ram" id="card-ram">
                <div class="card-header">
                    <div class="card-dot ram-dot"></div>
                    <span class="card-name ram-color">RAM</span>
                    <span class="card-subtitle" id="ram-subtitle"></span>
                </div>
                <div class="stats-row">
                    ${statBoxSkeleton(byId('ram-usage'))}
                    ${statBoxSkeleton(byId('vram-usage'))}
                </div>
            </div>

            <div class="card card-fps" id="card-fps">
                <div class="card-header">
                    <div class="card-dot fps-dot"></div>
                    <span class="card-name fps-color">FPS</span>
                </div>
                <div class="stats-row">
                    ${statBoxSkeleton(byId('fps'))}
                    ${statBoxSkeleton(byId('ftime'))}
                </div>
            </div>
        </div>`;

    els = {
        cpuCard:     document.getElementById('card-cpu'),
        gpuCard:     document.getElementById('card-gpu'),
        ramCard:     document.getElementById('card-ram'),
        fpsCard:     document.getElementById('card-fps'),
        cpuSubtitle: document.getElementById('cpu-subtitle'),
        gpuSubtitle: document.getElementById('gpu-subtitle'),
        ramSubtitle: document.getElementById('ram-subtitle'),
    };
    for (const def of STAT_DEFS) {
        els[def.id] = {
            box:  document.getElementById(`box-${def.id}`),
            val:  document.getElementById(`val-${def.id}`),
            unit: document.getElementById(`unit-${def.id}`),
        };
    }
    built = true;

    applyVisibility();
}

function setStat(id, entry, unitOverride) {
    const v = (entry && entry.value !== null && entry.value !== undefined)
        ? Math.round(entry.value)
        : null;
    const ref = els[id];
    if (!ref) return;
    ref.box.style.opacity = v === null ? '0.2' : '';
    ref.val.textContent   = v !== null ? v : '–';
    if (unitOverride !== undefined && ref.unit.textContent !== unitOverride) {
        ref.unit.textContent = unitOverride;
    }
}

function setFpsStat(id, value, decimals = 0) {
    const ref = els[id];
    if (!ref) return;
    if (value == null || value <= 0) {
        ref.box.style.opacity = '0.2';
        ref.val.textContent   = '–';
    } else {
        ref.box.style.opacity = '';
        ref.val.textContent   = decimals > 0 ? value.toFixed(decimals) : Math.round(value);
    }
}

function getThemeClass(label) {
    const l = (label || '').toLowerCase();
    if (l.includes('intel') || l.includes('arc'))                                    return 'theme-intel';
    if (l.includes('amd')   || l.includes('radeon') || l.includes('ryzen'))          return 'theme-amd';
    if (l.includes('nvidia')|| l.includes('geforce')|| l.includes('rtx') || l.includes('gtx')) return 'theme-nvidia';
    return 'theme-default';
}

const THEME_CLASSES = ['theme-intel', 'theme-amd', 'theme-nvidia', 'theme-default'];
function applyTheme(cardEl, themeClass) {
    if (!cardEl || cardEl.classList.contains(themeClass)) return;
    cardEl.classList.remove(...THEME_CLASSES);
    cardEl.classList.add(themeClass);
}

function setSubtitleIfChanged(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
}

// ── Initial state: show loading while Rust backend starts polling ─────────────
container.innerHTML = `
    <div class="loading">
        <div class="spinner"></div>
        Waiting for sensor data...
    </div>`;

// ── Tauri event listeners ─────────────────────────────────────────────────────

listen('sensor-update', (event) => {
    const payload = event.payload;
    const data    = payload.sensors ?? payload;

    if (!built) buildSkeleton();

    const GPU = 0;

    // System info
    const sysInfo  = payload.system_info ?? {};
    const gpuEntry = (sysInfo.gpus ?? [])[GPU] ?? {};

    const cpuLabel  = sysInfo.cpu_name ?? 'CPU';
    const gpuLabel  = gpuEntry.device  ?? 'GPU';
    const ramTotal  = sysInfo.ram_gb   != null ? `${sysInfo.ram_gb} GB` : '';
    const vramTotal = gpuEntry.vram_gb != null ? `${gpuEntry.vram_gb} GB VRAM` : '';

    setSubtitleIfChanged(els.cpuSubtitle, cpuLabel);
    setSubtitleIfChanged(els.gpuSubtitle, gpuLabel);
    setSubtitleIfChanged(els.ramSubtitle, [ramTotal, vramTotal].filter(Boolean).join(' · '));

    applyTheme(els.cpuCard, getThemeClass(cpuLabel));
    applyTheme(els.gpuCard, getThemeClass(gpuLabel));

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
    function findByName(sensors, name) {
        const lower = name.toLowerCase();
        return sensors.find(e => e.name && e.name.toLowerCase().includes(lower)) || null;
    }

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
    setFpsStat('ftime', ftimeVal, 2);

}).catch(err => console.error('Failed to listen to sensor-update:', err));

listen('sensor-error', (event) => {
    built = false;
    container.innerHTML = `
        <div class="loading">
            <div class="spinner"></div>
            ${event.payload}
        </div>`;
}).catch(err => console.error('Failed to listen to sensor-error:', err));

// ── Settings panel ────────────────────────────────────────────────────────────
const settingsPanel = document.getElementById('settings-panel');

// Dimensions & per-card heights for dynamic scaling
const BASE_WIDTH = 300;
const CARD_HEIGHTS = {
    cpu: 145,
    gpu: 145,
    ram: 100,
    fps: 100,
};

let currentBaseHeight = 490;

// Checkbox references
const showCpu = document.getElementById('show-cpu');
const showGpu = document.getElementById('show-gpu');
const showRam = document.getElementById('show-ram');
const showFps = document.getElementById('show-fps');

// Restore saved settings
showCpu.checked = localStorage.getItem('show-cpu') !== 'false';
showGpu.checked = localStorage.getItem('show-gpu') !== 'false';
showRam.checked = localStorage.getItem('show-ram') !== 'false';
showFps.checked = localStorage.getItem('show-fps') !== 'false';

// Safeguard: Ensure at least one monitor is checked (prevent missing window bug)
if (!showCpu.checked && !showGpu.checked && !showRam.checked && !showFps.checked) {
    showCpu.checked = true;
    localStorage.setItem('show-cpu', 'true');
}

function calcBaseHeight() {
    let h = 0;
    if (showCpu.checked) h += CARD_HEIGHTS.cpu;
    if (showGpu.checked) h += CARD_HEIGHTS.gpu;
    if (showRam.checked) h += CARD_HEIGHTS.ram;
    if (showFps.checked) h += CARD_HEIGHTS.fps;
    return Math.max(CARD_HEIGHTS.ram, h);
}

/**
 * Apply card visibility based on settings checkboxes.
 * Resizes window height to match remaining cards and enforces minimum of 1 checked monitor.
 */
async function applyVisibility() {
    const monitors = [
        { el: showCpu, id: 'card-cpu', key: 'show-cpu' },
        { el: showGpu, id: 'card-gpu', key: 'show-gpu' },
        { el: showRam, id: 'card-ram', key: 'show-ram' },
        { el: showFps, id: 'card-fps', key: 'show-fps' },
    ];

    const checked = monitors.filter(m => m.el.checked);

    // Safeguard: if only 1 is checked, disable that checkbox so it cannot be unchecked
    if (checked.length === 1) {
        checked[0].el.disabled = true;
        checked[0].el.parentElement.title = 'At least 1 monitor must remain selected';
        monitors.forEach(m => {
            if (m.el !== checked[0].el) {
                m.el.disabled = false;
                m.el.parentElement.removeAttribute('title');
            }
        });
    } else {
        monitors.forEach(m => {
            m.el.disabled = false;
            m.el.parentElement.removeAttribute('title');
        });
    }

    // Toggle card visibility & mark last visible card for border styling
    const visibleCards = [];
    monitors.forEach(m => {
        const card = document.getElementById(m.id);
        if (card) {
            card.style.display = m.el.checked ? '' : 'none';
            card.classList.remove('last-visible-card');
            if (m.el.checked) {
                visibleCards.push(card);
            }
        }
        localStorage.setItem(m.key, m.el.checked);
    });

    if (visibleCards.length > 0) {
        visibleCards[visibleCards.length - 1].classList.add('last-visible-card');
    }

    // Recompute base height and adjust viewport
    const newBaseHeight = calcBaseHeight();
    currentBaseHeight = newBaseHeight;

    const viewport = document.getElementById('app-viewport');
    if (viewport) {
        viewport.style.height = `${newBaseHeight}px`;
    }

    // Notify backend of the new base height for aspect ratio locking during resize dragging
    try {
        await invoke('set_base_height', { height: newBaseHeight });
    } catch (err) {
        console.error('set_base_height error:', err);
    }

    // Resize window height to match the new content height
    try {
        const savedScale = parseFloat(localStorage.getItem('app-scale') || '1.0');
        const scale = isNaN(savedScale) ? 1.0 : Math.max(0.6, Math.min(3.0, savedScale));
        const targetW = Math.round(BASE_WIDTH * scale);
        const targetH = Math.round(newBaseHeight * scale);
        await appWindow.setSize(new LogicalSize(targetW, targetH));
    } catch (err) {
        console.error('Failed to resize window for visibility change:', err);
    }
}

function handleMonitorToggle() {
    const checkedCount = [showCpu, showGpu, showRam, showFps].filter(cb => cb.checked).length;
    if (checkedCount === 0) {
        // Prevent unchecking the last remaining monitor
        this.checked = true;
        return;
    }
    applyVisibility();
}

showCpu.addEventListener('change', handleMonitorToggle);
showGpu.addEventListener('change', handleMonitorToggle);
showRam.addEventListener('change', handleMonitorToggle);
showFps.addEventListener('change', handleMonitorToggle);

// ── Permanent transparent window background ──────────────────────────────────
document.documentElement.style.backgroundColor = 'transparent';
document.body.style.backgroundColor = 'transparent';

// ── Click-Through (pass clicks to windows/games beneath) ─────────────────────
const clickthroughToggle = document.getElementById('clickthrough-toggle');
let lastBypassSeq = 0;

async function setClickthrough(enabled) {
    try {
        if (!enabled) {
            document.body.classList.remove('clickthrough-bypassed');
        }
        await appWindow.setIgnoreCursorEvents(enabled);
        await invoke('set_clickthrough_active', { active: enabled });
        if (clickthroughToggle) clickthroughToggle.checked = enabled;
        localStorage.setItem('click-through', enabled);
        if (enabled && settingsPanel && !settingsPanel.classList.contains('hidden')) {
            settingsPanel.classList.add('hidden');
            if (settingsBtn) settingsBtn.classList.remove('active');
        }
    } catch (err) {
        console.error('Failed to set click-through:', err);
    }
}

// Restore saved click-through setting (default = false)
const initialClickthrough = localStorage.getItem('click-through') === 'true';
if (clickthroughToggle) {
    clickthroughToggle.checked = initialClickthrough;
    if (initialClickthrough) {
        setClickthrough(true);
    }
    clickthroughToggle.addEventListener('change', () => {
        setClickthrough(clickthroughToggle.checked);
    });
}

// Listen for Right-Alt bypass event from Rust backend
listen('bypass-clickthrough', async (event) => {
    const isBypassing = Boolean(event.payload);
    const seq = ++lastBypassSeq;

    // 1. Immediately update visual glow synchronously to prevent async race conditions
    if (!isBypassing || !clickthroughToggle || !clickthroughToggle.checked) {
        document.body.classList.remove('clickthrough-bypassed');
    } else {
        document.body.classList.add('clickthrough-bypassed');
    }

    // 2. Apply window cursor event pass-through
    if (clickthroughToggle && clickthroughToggle.checked) {
        try {
            await appWindow.setIgnoreCursorEvents(!isBypassing);
        } catch (err) {
            console.error('Failed to update bypass state:', err);
        }
    }

    // 3. Stale sequence check: if a newer event arrived while awaiting, do not overwrite
    if (seq !== lastBypassSeq) return;

    if (!isBypassing || !clickthroughToggle || !clickthroughToggle.checked) {
        document.body.classList.remove('clickthrough-bypassed');
    } else {
        document.body.classList.add('clickthrough-bypassed');
    }
}).catch(err => console.error('Failed to listen to bypass-clickthrough:', err));

// Safety fallback: if Alt is released while window has focus, immediately clear glow
window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt' || e.code === 'AltRight' || e.code === 'AltLeft') {
        document.body.classList.remove('clickthrough-bypassed');
        if (clickthroughToggle && clickthroughToggle.checked) {
            appWindow.setIgnoreCursorEvents(true).catch(() => {});
        }
    }
});

// Safety fallback: if window blurs, ensure no stuck glow
window.addEventListener('blur', () => {
    if (!clickthroughToggle || !clickthroughToggle.checked) {
        document.body.classList.remove('clickthrough-bypassed');
    }
});

// ── Always on Top (toggle in settings panel) ──────────────────────────────────
const aotToggle = document.getElementById('aot-toggle');

aotToggle.checked = localStorage.getItem('always-on-top') !== 'false';
appWindow.setAlwaysOnTop(aotToggle.checked);

aotToggle.addEventListener('change', () => {
    appWindow.setAlwaysOnTop(aotToggle.checked);
    localStorage.setItem('always-on-top', aotToggle.checked);
});

// ── Settings button toggle, dragging & keyboard shortcut ─────────────────────
const settingsBtn = document.getElementById('settings-btn');

function toggleSettings() {
    if (!settingsPanel) return;
    const isHidden = settingsPanel.classList.toggle('hidden');
    if (settingsBtn) {
        settingsBtn.classList.toggle('active', !isHidden);
    }
}

let isMouseDownOnSettings = false;
let startX = 0;
let startY = 0;
let hasDragged = false;
let dragTimer = null;

if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // Left mouse button only
        isMouseDownOnSettings = true;
        hasDragged = false;
        startX = e.screenX;
        startY = e.screenY;

        // If held down for > 150ms, initiate window drag
        clearTimeout(dragTimer);
        dragTimer = setTimeout(async () => {
            if (isMouseDownOnSettings && !hasDragged) {
                hasDragged = true;
                try {
                    await appWindow.startDragging();
                } catch (err) {
                    console.error('startDragging error:', err);
                }
            }
        }, 150);
    });

    settingsBtn.addEventListener('click', (e) => {
        clearTimeout(dragTimer);
        if (hasDragged) {
            hasDragged = false;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        toggleSettings();
    });
}

window.addEventListener('mousemove', async (e) => {
    if (!isMouseDownOnSettings || hasDragged) return;
    const dx = Math.abs(e.screenX - startX);
    const dy = Math.abs(e.screenY - startY);
    if (dx > 3 || dy > 3) {
        hasDragged = true;
        clearTimeout(dragTimer);
        try {
            await appWindow.startDragging();
        } catch (err) {
            console.error('startDragging error:', err);
        }
    }
});

window.addEventListener('mouseup', () => {
    isMouseDownOnSettings = false;
    clearTimeout(dragTimer);
    setTimeout(() => {
        hasDragged = false;
    }, 120);
});

window.addEventListener('blur', () => {
    isMouseDownOnSettings = false;
    clearTimeout(dragTimer);
});

window.addEventListener('keydown', (e) => {
    if (e.key === 's' || e.key === 'S') {
        toggleSettings();
    }
});

// ── Window controls (in settings dropdown) ───────────────────────────────────
const btnMinimize = document.getElementById('btn-minimize');
const btnClose    = document.getElementById('btn-close');

if (btnMinimize) {
    btnMinimize.addEventListener('click', () => {
        appWindow.minimize();
    });
}

if (btnClose) {
    btnClose.addEventListener('click', () => {
        appWindow.close();
    });
}

// ── Window scaling & position persistence ────────────────────────────────────
function updateScaleUI(scale) {
    document.documentElement.style.setProperty('--app-scale', scale);
}

// Wire up 4 corner resize handles (resizable only from each edge/corner)
document.querySelectorAll('.corner-resize').forEach(corner => {
    corner.addEventListener('mousedown', async (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const direction = corner.dataset.direction;
        try {
            await appWindow.startResizeDragging(direction);
        } catch (err) {
            console.error('startResizeDragging error:', err);
        }
    });
});

// Window resize listener — keeps layout scaling proportional to window size
let resizeTimer = null;
window.addEventListener('resize', () => {
    const scale = Math.min(window.innerWidth / BASE_WIDTH, window.innerHeight / currentBaseHeight);
    updateScaleUI(scale);

    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
        try {
            const isMax = await appWindow.isMaximized();
            const isMin = await appWindow.isMinimized();
            if (!isMax && !isMin) {
                const snappedScale = Math.max(0.6, Math.min(3.0, scale));
                const targetW = Math.round(BASE_WIDTH * snappedScale);
                const targetH = Math.round(currentBaseHeight * snappedScale);
                await appWindow.setSize(new LogicalSize(targetW, targetH));
                localStorage.setItem('app-scale', snappedScale);
            }
        } catch (err) {
            console.error('Failed to snap window size:', err);
        }
    }, 150);
});

(async function initWindowPersistence() {
    try {
        currentBaseHeight = calcBaseHeight();
        try {
            await invoke('set_base_height', { height: currentBaseHeight });
        } catch (_) {}

        // Restore saved scale (default = 1.0)
        const savedScale = parseFloat(localStorage.getItem('app-scale') || '1.0');
        const scale = isNaN(savedScale) ? 1.0 : Math.max(0.6, Math.min(3.0, savedScale));
        const targetW = Math.round(BASE_WIDTH * scale);
        const targetH = Math.round(currentBaseHeight * scale);
        await appWindow.setSize(new LogicalSize(targetW, targetH));
        updateScaleUI(scale);

        // Restore saved position
        const savedX = localStorage.getItem('window-x');
        const savedY = localStorage.getItem('window-y');
        if (savedX !== null && savedY !== null) {
            const x = parseInt(savedX, 10);
            const y = parseInt(savedY, 10);
            if (x > -10000 && y > -10000) {
                await appWindow.setPosition(new PhysicalPosition(x, y));
            }
        }
    } catch (err) {
        console.error('Failed to initialize window size/position:', err);
    }

    // Save position whenever moved
    let moveTimer = null;
    appWindow.onMoved(({ payload: position }) => {
        clearTimeout(moveTimer);
        moveTimer = setTimeout(async () => {
            try {
                const isMax = await appWindow.isMaximized();
                const isMin = await appWindow.isMinimized();
                if (!isMax && !isMin && position.x > -10000 && position.y > -10000) {
                    localStorage.setItem('window-x', position.x);
                    localStorage.setItem('window-y', position.y);
                }
            } catch (err) {
                console.error('Failed to save window position:', err);
            }
        }, 150);
    });
})();

