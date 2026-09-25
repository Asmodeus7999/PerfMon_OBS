/**
 * state.js — shared Tauri handle, DOM refs, and mutable state used across modules.
 *
 * Everything here is a single source of truth so modules don't each re-query the
 * DOM or duplicate mutable fields. `state` is a plain object with live properties
 * (not exported `let` bindings), so any module can read and write the same values.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';

export const appWindow = getCurrentWindow();

// ── DOM refs (looked up once) ─────────────────────────────────────────────────
export const dom = {
    container:          document.getElementById('osd-container'),
    settingsPanel:       document.getElementById('settings-panel'),
    settingsBtn:         document.getElementById('settings-btn'),
    themeSelect:         document.getElementById('theme-select'),
    showCpu:             document.getElementById('show-cpu'),
    showGpu:             document.getElementById('show-gpu'),
    showRam:             document.getElementById('show-ram'),
    showFps:             document.getElementById('show-fps'),
    bgSlider:            document.getElementById('bg-opacity'),
    bgSliderVal:         document.getElementById('bg-opacity-val'),
    clickthroughToggle:  document.getElementById('clickthrough-toggle'),
    aotToggle:           document.getElementById('aot-toggle'),
    btnMinimize:         document.getElementById('btn-minimize'),
    btnClose:            document.getElementById('btn-close'),
};

// ── Per-theme base dimensions for dynamic scaling ─────────────────────────────
//   default — vertical stack of cards (unchanged from before)
//   classic — MSI Afterburner-style horizontal rows (≈ 410 × 110)
export const THEMES = {
    default: { width: 300, cardHeights: { cpu: 145, gpu: 145, ram: 100, fps: 100 }, padding: 0, minHeight: 100 },
    classic: { width: 410, cardHeights: { cpu: 26,  gpu: 26,  ram: 26,  fps: 26  }, padding: 6, minHeight: 32  },
};

// Starting background-opacity percentage per theme (matches each theme's original look)
export const BG_DEFAULT_PCT = { default: 85, classic: 55 };

// Source IDs from MSI Afterburner SDK (MAHMSharedMemory.h) — unchanged from original
export const SRC = {
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

// ── Mutable shared state (live properties, not re-exported bindings) ─────────
let initialTheme = localStorage.getItem('theme');
if (!THEMES[initialTheme]) initialTheme = 'default';

export const state = {
    // Skeleton (built by modules/skeleton.js)
    built: false,
    els: {},

    // Theme + sizing
    currentTheme: initialTheme,
    BASE_WIDTH: THEMES[initialTheme].width,
    currentBaseHeight: 490,

    // Animated viewport size (modules/window-size.js)
    viewW: THEMES[initialTheme].width,
    viewH: 490,
    sizeAnimToken: 0,
    sizeAnimUntil: 0,

    // Settings-panel expansion in the Classic theme (modules/window-size.js)
    panelExpandedHeight: 0,
};

document.body.dataset.theme = state.currentTheme;
