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

import './classic.css';
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
    CORE_CLOCK: 0x20,
    GPU_USAGE: 0x30,
    MEMORY_USAGE: 0x31,
    GPU_ABS_POWER: 0x61,
    CPU_TEMPERATURE: 0x80,
    CPU_USAGE: 0x90,
    RAM_USAGE: 0x91,
    CPU_CLOCK: 0xA0,
    CPU_POWER: 0x100,
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
    { id: 'cpu-temp', unit: '°C', label: 'Temp', widthClass: 'sw-3d' },
    { id: 'cpu-load', unit: '%', label: 'Load', widthClass: 'sw-3d' },
    { id: 'cpu-power', unit: 'W', label: 'Power', widthClass: 'sw-3d' },
    { id: 'cpu-clock', unit: 'MHz', label: 'Clock', widthClass: 'sw-4d' },
    { id: 'gpu-temp', unit: '°C', label: 'Temp', widthClass: 'sw-3d' },
    { id: 'gpu-load', unit: '%', label: 'Load', widthClass: 'sw-3d' },
    { id: 'gpu-power', unit: 'W', label: 'Power', widthClass: 'sw-3d' },
    { id: 'gpu-clock', unit: 'MHz', label: 'Clock', widthClass: 'sw-4d' },
    { id: 'ram-usage', unit: 'MB', label: 'System RAM', widthClass: 'sw-5d' },
    { id: 'vram-usage', unit: 'MB', label: 'VRAM', widthClass: 'sw-5d' },
    { id: 'fps', unit: 'FPS', label: 'Framerate', widthClass: 'sw-3d' },
    { id: 'ftime', unit: 'ms', label: 'Frametime', widthClass: 'sw-4d' },
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
                    <span class="card-short themed-color" id="cpu-short"></span>
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
                    <span class="card-short themed-color" id="gpu-short"></span>
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
        cpuCard: document.getElementById('card-cpu'),
        gpuCard: document.getElementById('card-gpu'),
        ramCard: document.getElementById('card-ram'),
        fpsCard: document.getElementById('card-fps'),
        cpuShort: document.getElementById('cpu-short'),
        gpuShort: document.getElementById('gpu-short'),
        cpuSubtitle: document.getElementById('cpu-subtitle'),
        gpuSubtitle: document.getElementById('gpu-subtitle'),
        ramSubtitle: document.getElementById('ram-subtitle'),
    };
    for (const def of STAT_DEFS) {
        els[def.id] = {
            box: document.getElementById(`box-${def.id}`),
            val: document.getElementById(`val-${def.id}`),
            unit: document.getElementById(`unit-${def.id}`),
        };
    }
    built = true;

    applyVisibility();
}

function setStat(id, entry, unitOverride) {
    // Classic theme shows power with one decimal (e.g. 37.6 W), like Afterburner
    const dec = (currentTheme === 'classic' && id.endsWith('-power')) ? 1 : 0;
    const v = (entry && entry.value !== null && entry.value !== undefined)
        ? (dec > 0 ? Number(entry.value.toFixed(dec)) : Math.round(entry.value))
        : null;
    const ref = els[id];
    if (!ref) return;
    ref.box.style.opacity = v === null ? '0.2' : '';
    ref.val.textContent = v !== null ? v : '–';
    if (unitOverride !== undefined && ref.unit.textContent !== unitOverride) {
        ref.unit.textContent = unitOverride;
    }
}

function setFpsStat(id, value, decimals = 0) {
    const ref = els[id];
    if (!ref) return;
    if (value == null || value <= 0) {
        ref.box.style.opacity = '0.2';
        ref.val.textContent = '–';
    } else {
        ref.box.style.opacity = '';
        ref.val.textContent = decimals > 0 ? value.toFixed(decimals) : Math.round(value);
    }
}

function getThemeClass(label) {
    const l = (label || '').toLowerCase();
    if (l.includes('intel') || l.includes('arc')) return 'theme-intel';
    if (l.includes('amd') || l.includes('radeon') || l.includes('ryzen')) return 'theme-amd';
    if (l.includes('nvidia') || l.includes('geforce') || l.includes('rtx') || l.includes('gtx')) return 'theme-nvidia';
    return 'theme-default';
}

const THEME_CLASSES = ['theme-intel', 'theme-amd', 'theme-nvidia', 'theme-default'];
function applyTheme(cardEl, themeClass) {
    if (!cardEl || cardEl.classList.contains(themeClass)) return;
    cardEl.classList.remove(...THEME_CLASSES);
    cardEl.classList.add(themeClass);
}

// Short labels for the Classic theme, e.g. "Intel Core i5-4690" → "i5-4690",
// "AMD Radeon RX 580 Series" → "RX580".
function shortCpuName(name) {
    const n = name || '';
    let m = n.match(/\bi[3579]-\w+/i);
    if (m) return m[0];
    m = n.match(/Ultra\s*([3579])\s*(\w+)/i);
    if (m) return `U${m[1]} ${m[2]}`;
    m = n.match(/Ryzen\s*(?:Threadripper\s*)?([3579])?\s*(\d{3,4}\w*)/i);
    if (m) return m[1] ? `R${m[1]} ${m[2]}` : m[2];
    const cleaned = n.replace(/\b(Intel|AMD|Core|Processor|with|Radeon|Graphics)\b/gi, '')
        .replace(/\s+/g, ' ').trim();
    return (cleaned || 'CPU').slice(0, 10);
}

function shortGpuName(name) {
    const n = name || '';
    let m = n.match(/\b(RTX|GTX|GT|RX)\s*(\d{3,4})\s*(Ti\s*SUPER|Ti|SUPER|XTX|XT|GRE)?/i);
    if (m) return `${m[1].toUpperCase()}${m[2]}${m[3] ? m[3].replace(/\s+/g, '') : ''}`;
    m = n.match(/Arc\s*(?:Pro\s*)?([AB]\d{3}\w*)/i);
    if (m) return `Arc ${m[1]}`;
    const cleaned = n.replace(/\((R|TM)\)/gi, '').replace(/\b(NVIDIA|AMD|Intel|GeForce|Radeon|Graphics|Series)\b/gi, '')
        .replace(/\s+/g, ' ').trim();
    return (cleaned || 'GPU').slice(0, 10);
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
    const data = payload.sensors ?? payload;

    if (!built) buildSkeleton();

    const GPU = 0;

    // System info
    const sysInfo = payload.system_info ?? {};
    const gpuEntry = (sysInfo.gpus ?? [])[GPU] ?? {};

    const cpuLabel = sysInfo.cpu_name ?? 'CPU';
    const gpuLabel = gpuEntry.device ?? 'GPU';
    const ramTotal = sysInfo.ram_gb != null ? `${sysInfo.ram_gb} GB` : '';
    const vramTotal = gpuEntry.vram_gb != null ? `${gpuEntry.vram_gb} GB VRAM` : '';

    setSubtitleIfChanged(els.cpuShort, shortCpuName(cpuLabel));
    setSubtitleIfChanged(els.gpuShort, shortGpuName(gpuLabel));
    setSubtitleIfChanged(els.cpuSubtitle, cpuLabel);
    setSubtitleIfChanged(els.gpuSubtitle, gpuLabel);
    setSubtitleIfChanged(els.ramSubtitle, [ramTotal, vramTotal].filter(Boolean).join(' · '));

    applyTheme(els.cpuCard, getThemeClass(cpuLabel));
    applyTheme(els.gpuCard, getThemeClass(gpuLabel));

    // Sensor values
    setStat('cpu-temp', findBySrcId(data, SRC.CPU_TEMPERATURE));
    setStat('cpu-load', findBySrcId(data, SRC.CPU_USAGE));
    setStat('cpu-power', findBySrcId(data, SRC.CPU_POWER));
    setStat('cpu-clock', findBySrcId(data, SRC.CPU_CLOCK));

    setStat('gpu-temp', findBySrcId(data, SRC.GPU_TEMPERATURE, GPU));
    setStat('gpu-load', findBySrcId(data, SRC.GPU_USAGE, GPU));
    setStat('gpu-power', findBySrcId(data, SRC.GPU_ABS_POWER, GPU));
    setStat('gpu-clock', findBySrcId(data, SRC.CORE_CLOCK, GPU));

    const ramUsage = findBySrcId(data, SRC.RAM_USAGE);
    setStat('ram-usage', ramUsage, ramUsage?.units ?? 'MB');
    setStat('vram-usage', findBySrcId(data, SRC.MEMORY_USAGE, GPU));

    // FPS from RTSS or Afterburner sensor fallback
    function findByName(sensors, name) {
        const lower = name.toLowerCase();
        return sensors.find(e => e.name && e.name.toLowerCase().includes(lower)) || null;
    }

    let fpsVal = payload.fps?.fps;
    let ftimeVal = payload.fps?.frame_time_ms;

    if (fpsVal == null || fpsVal <= 0) {
        const fpsEntry = findByName(data, 'framerate');
        if (fpsEntry && fpsEntry.value != null && fpsEntry.value > 0) fpsVal = fpsEntry.value;
    }
    if (ftimeVal == null || ftimeVal <= 0) {
        const ftimeEntry = findByName(data, 'frametime');
        if (ftimeEntry && ftimeEntry.value != null && ftimeEntry.value > 0) ftimeVal = ftimeEntry.value;
    }

    setFpsStat('fps', fpsVal, 0);
    setFpsStat('ftime', ftimeVal, currentTheme === 'classic' ? 1 : 2);

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

// Per-theme base dimensions for dynamic scaling.
//   default — vertical stack of cards (unchanged from before)
//   classic — MSI Afterburner-style horizontal rows (≈ 410 × 110; tweak here)
const THEMES = {
    default: { width: 300, cardHeights: { cpu: 145, gpu: 145, ram: 100, fps: 100 }, padding: 0, minHeight: 100 },
    classic: { width: 410, cardHeights: { cpu: 26, gpu: 26, ram: 26, fps: 26 }, padding: 6, minHeight: 32 },
};

let currentTheme = localStorage.getItem('theme');
if (!THEMES[currentTheme]) currentTheme = 'default';
document.body.dataset.theme = currentTheme;

let BASE_WIDTH = THEMES[currentTheme].width;
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
    const t = THEMES[currentTheme];
    let h = 0;
    if (showCpu.checked) h += t.cardHeights.cpu;
    if (showGpu.checked) h += t.cardHeights.gpu;
    if (showRam.checked) h += t.cardHeights.ram;
    if (showFps.checked) h += t.cardHeights.fps;
    return Math.max(t.minHeight, h + t.padding);
}

// ── Animated window / viewport resizing ───────────────────────────────────────
// Size changes (theme switch, showing/hiding rows) glide instead of snapping.
// Same duration + easing as the settings-button transition in classic.css so the
// two move together.
const SIZE_ANIM_MS = 400;
let viewW = BASE_WIDTH;            // size currently shown by #app-viewport (base px, unscaled)
let viewH = currentBaseHeight;
let sizeAnimToken = 0;             // bumped to cancel a running animation
let sizeAnimUntil = 0;             // resize events before this time are ours, not the user's

function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = t => ((ax * t + bx) * t + cx) * t;
    const Y = t => ((ay * t + by) * t + cy) * t;
    return (x) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let t = x;
        for (let i = 0; i < 8; i++) {           // Newton's method
            const d = (3 * ax * t + 2 * bx) * t + cx;
            if (Math.abs(d) < 1e-6) break;
            t -= (X(t) - x) / d;
        }
        return Y(Math.min(1, Math.max(0, t)));
    };
}
const sizeEase = cubicBezier(0.4, 0, 0.2, 1);  // matches classic.css

// ── Settings panel expansion (Classic theme) ─────────────────────────────────
// The classic window is only ~110px tall, too short for the settings panel. While the
// panel is open in Classic, the window grows to fit it (animated) and shrinks back when
// it closes. panelExpandedHeight is 0 whenever no expansion is needed.
let panelExpandedHeight = 0;

/** Height (base px) the window should currently have: content, or the open panel if taller. */
function windowBaseHeight() {
    return Math.max(currentBaseHeight, panelExpandedHeight);
}

/** Natural full height of the settings panel in base px (measured on a hidden clone). */
function measureSettingsPanel() {
    const viewport = document.getElementById('app-viewport');
    if (!settingsPanel || !viewport) return 0;
    const clone = settingsPanel.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    clone.classList.remove('hidden');
    clone.style.cssText = 'visibility:hidden;pointer-events:none;transition:none;max-height:none;height:auto;overflow:visible;';
    viewport.appendChild(clone);
    const h = Math.ceil(clone.getBoundingClientRect().height / getCurrentUiScale());
    clone.remove();
    return h;
}

/** Decide whether the window should currently be expanded for the panel; returns true if so. */
function syncPanelExpansion() {
    const open = settingsPanel && !settingsPanel.classList.contains('hidden');
    const expand = !!open && currentTheme === 'classic';
    panelExpandedHeight = expand ? measureSettingsPanel() : 0;
    if (expand) document.body.classList.add('settings-expanded');
    return expand;
}

function getCurrentUiScale() {
    const s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale'));
    return s > 0 ? s : 1;
}

function setViewSize(w, h) {
    viewW = w;
    viewH = h;
    const viewport = document.getElementById('app-viewport');
    if (viewport) {
        viewport.style.width = `${w}px`;
        viewport.style.height = `${h}px`;
    }
}

function applyViewportSize() {
    setViewSize(BASE_WIDTH, windowBaseHeight());
    document.body.style.setProperty('--content-h', `${currentBaseHeight}px`);
}

/** Animate the viewport and the real window from the current size to (toW × toH) base px. */
async function animateSize(toW, toH, scale) {
    const fromW = viewW, fromH = viewH;
    const token = ++sizeAnimToken;
    const winSize = (w, h) => new LogicalSize(Math.round(w * scale), Math.round(h * scale));

    sizeAnimUntil = performance.now() + SIZE_ANIM_MS + 300;
    if (fromW !== toW || fromH !== toH) {
        const t0 = performance.now();
        await new Promise((resolve) => {
            const step = (now) => {
                if (token !== sizeAnimToken) return resolve();      // superseded by a newer resize
                const p = Math.min(1, (now - t0) / SIZE_ANIM_MS);
                const e = sizeEase(p);
                const w = fromW + (toW - fromW) * e;
                const h = fromH + (toH - fromH) * e;
                setViewSize(w, h);
                appWindow.setSize(winSize(w, h)).catch(() => { });
                if (p < 1) requestAnimationFrame(step); else resolve();
            };
            requestAnimationFrame(step);
        });
    }
    if (token !== sizeAnimToken) return;
    setViewSize(toW, toH);
    await appWindow.setSize(winSize(toW, toH));
    sizeAnimUntil = performance.now() + 300;   // ignore the trailing resize events
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
    document.body.style.setProperty('--content-h', `${newBaseHeight}px`);
    syncPanelExpansion();                       // Classic: grow to fit the settings panel if open
    const targetHeight = windowBaseHeight();

    // Notify backend of the new base size for aspect ratio locking during resize dragging
    try {
        await invoke('set_base_size', { width: BASE_WIDTH, height: targetHeight });
    } catch (err) {
        console.error('set_base_size error:', err);
    }

    // Glide the viewport + window to the new size
    try {
        const savedScale = parseFloat(localStorage.getItem('app-scale') || '1.0');
        const scale = isNaN(savedScale) ? 1.0 : Math.max(0.6, Math.min(3.0, savedScale));
        await animateSize(BASE_WIDTH, targetHeight, scale);
    } catch (err) {
        console.error('Failed to resize window for visibility change:', err);
    }

    // Once the window has shrunk back, un-pin the settings button
    if (!panelExpandedHeight) document.body.classList.remove('settings-expanded');
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

// ── Theme selection (default = vertical, classic = Afterburner-style horizontal)
const themeSelect = document.getElementById('theme-select');
if (themeSelect) {
    themeSelect.value = currentTheme;
    let themeSwitchToken = 0;
    const GEAR_FADE_MS = 200;   // matches the settings button's 0.2s opacity transition

    themeSelect.addEventListener('change', async () => {
        const next = THEMES[themeSelect.value] ? themeSelect.value : 'default';
        if (next === currentTheme) return;
        const token = ++themeSwitchToken;

        // Settings button: fade out where it is, swap the theme, fade back in at the new spot
        document.body.classList.add('gear-hidden');
        await new Promise((r) => setTimeout(r, GEAR_FADE_MS));
        if (token !== themeSwitchToken) return;

        currentTheme = next;
        BASE_WIDTH = THEMES[next].width;
        document.body.dataset.theme = next;
        localStorage.setItem('theme', next);
        loadBgOpacity();
        await applyVisibility(); // recomputes size, animates the window, updates backend aspect ratio

        if (token === themeSwitchToken) document.body.classList.remove('gear-hidden');
    });
}

// ── Background opacity slider (widget background only — text/values are unaffected)
// Stored per theme so each theme keeps its own level; defaults match the original looks.
const BG_DEFAULT_PCT = { default: 85, classic: 55 };
const bgSlider = document.getElementById('bg-opacity');
const bgSliderVal = document.getElementById('bg-opacity-val');

function applyBgOpacity(pct) {
    document.body.style.setProperty('--bg-alpha', String(pct / 100));
    if (bgSlider) bgSlider.value = String(pct);
    if (bgSliderVal) bgSliderVal.textContent = `${pct}%`;
}

function loadBgOpacity() {
    const saved = parseInt(localStorage.getItem(`bg-opacity-${currentTheme}`), 10);
    applyBgOpacity(Number.isNaN(saved) ? BG_DEFAULT_PCT[currentTheme] : Math.max(0, Math.min(100, saved)));
}

if (bgSlider) {
    bgSlider.addEventListener('input', () => {
        const pct = parseInt(bgSlider.value, 10);
        applyBgOpacity(pct);
        localStorage.setItem(`bg-opacity-${currentTheme}`, String(pct));
    });
}
loadBgOpacity();

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
            document.body.classList.add('settings-expanding');
            applyVisibility().finally(() => {
                document.body.classList.remove('settings-expanding');
            });
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
            appWindow.setIgnoreCursorEvents(true).catch(() => { });
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

aotToggle.checked = localStorage.getItem('always-on-top') === 'true'; // off by default
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
    document.body.classList.add('settings-expanding');   // hide the panel's scrollbar mid-resize
    applyVisibility().finally(() => {                     // Classic: grow/shrink window to fit the panel
        document.body.classList.remove('settings-expanding');
    });
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

// ── Window controls (in settings dropdown) ───────────────────────────────────
const btnMinimize = document.getElementById('btn-minimize');
const btnClose = document.getElementById('btn-close');

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
    if (performance.now() < sizeAnimUntil) return;   // our own animated resize — not a user drag
    const scale = Math.min(window.innerWidth / BASE_WIDTH, window.innerHeight / windowBaseHeight());
    updateScaleUI(scale);

    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
        if (performance.now() < sizeAnimUntil) return;
        try {
            const isMax = await appWindow.isMaximized();
            const isMin = await appWindow.isMinimized();
            if (!isMax && !isMin) {
                const snappedScale = Math.max(0.6, Math.min(3.0, scale));
                const targetW = Math.round(BASE_WIDTH * snappedScale);
                const targetH = Math.round(windowBaseHeight() * snappedScale);
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
        applyViewportSize();
        try {
            await invoke('set_base_size', { width: BASE_WIDTH, height: currentBaseHeight });
        } catch (_) { }

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