/**
 * main.js — PerfMon OBS Tauri frontend entry point.
 *
 * Adapted from overlay/script.js. Key changes:
 *   - WebSocket removed; replaced with Tauri event listeners (listen())
 *   - FPS / frametime card added (uses payload.fps from Rust backend)
 *   - Settings panel wired up (show/hide per-card, persisted in localStorage)
 *   - Theme (Default / Classic), per-theme sizing, animated resizing, background
 *     opacity, click-through, and window persistence — see src/modules/*.
 *
 * The sensor data structure emitted from Rust (SensorPayload) is intentionally
 * compatible with the old JSON format, see modules/sensors.js for details.
 */
import './classic.css';

import { initSensors } from './modules/sensors.js';
import { initThemeSelect } from './modules/theme-select.js';
import { initBackgroundOpacity } from './modules/background-opacity.js';
import { initClickThrough } from './modules/click-through.js';
import { initSettingsPanel } from './modules/settings-panel.js';
import { initWindowControls } from './modules/window-controls.js';

initSensors();
initThemeSelect();
initBackgroundOpacity();
initClickThrough();
initSettingsPanel();
initWindowControls();
