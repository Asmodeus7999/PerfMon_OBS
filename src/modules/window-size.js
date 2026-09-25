/**
 * window-size.js — animated resizing of the app viewport and the real Tauri window.
 *
 * Size changes (theme switch, showing/hiding rows, settings-panel expansion) glide
 * instead of snapping. Uses the same duration + easing as the settings-button
 * transition in classic.css so the two move together.
 */
import { LogicalSize } from '@tauri-apps/api/window';
import { appWindow, dom, state, THEMES } from './state.js';

const SIZE_ANIM_MS = 400;

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

export function calcBaseHeight() {
    const t = THEMES[state.currentTheme];
    let h = 0;
    if (dom.showCpu.checked) h += t.cardHeights.cpu;
    if (dom.showGpu.checked) h += t.cardHeights.gpu;
    if (dom.showRam.checked) h += t.cardHeights.ram;
    if (dom.showFps.checked) h += t.cardHeights.fps;
    return Math.max(t.minHeight, h + t.padding);
}

// ── Settings panel expansion (Classic theme) ─────────────────────────────────
// The classic window is only ~110px tall, too short for the settings panel. While the
// panel is open in Classic, the window grows to fit it (animated) and shrinks back when
// it closes. state.panelExpandedHeight is 0 whenever no expansion is needed.

/** Height (base px) the window should currently have: content, or the open panel if taller. */
export function windowBaseHeight() {
    return Math.max(state.currentBaseHeight, state.panelExpandedHeight);
}

export function getCurrentUiScale() {
    const s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale'));
    return s > 0 ? s : 1;
}

/** Natural full height of the settings panel in base px (measured on a hidden clone). */
function measureSettingsPanel() {
    const viewport = document.getElementById('app-viewport');
    if (!dom.settingsPanel || !viewport) return 0;
    const clone = dom.settingsPanel.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    clone.classList.remove('hidden');
    clone.style.cssText = 'visibility:hidden;pointer-events:none;transition:none;max-height:none;height:auto;bottom:auto;overflow:visible;';
    viewport.appendChild(clone);
    const h = Math.ceil(clone.getBoundingClientRect().height / getCurrentUiScale());
    clone.remove();
    return h;
}

/** Decide whether the window should currently be expanded for the panel; returns true if so. */
export function syncPanelExpansion() {
    const open = dom.settingsPanel && !dom.settingsPanel.classList.contains('hidden');
    const expand = !!open && state.currentTheme === 'classic';
    state.panelExpandedHeight = expand ? measureSettingsPanel() : 0;
    if (expand) document.body.classList.add('settings-expanded');
    return expand;
}

function setViewSize(w, h) {
    state.viewW = w;
    state.viewH = h;
    const viewport = document.getElementById('app-viewport');
    if (viewport) {
        viewport.style.width = `${w}px`;
        viewport.style.height = `${h}px`;
    }
}

export function applyViewportSize() {
    setViewSize(state.BASE_WIDTH, windowBaseHeight());
    document.body.style.setProperty('--content-h', `${state.currentBaseHeight}px`);
}

/** Animate the viewport and the real window from the current size to (toW × toH) base px. */
export async function animateSize(toW, toH, scale) {
    const fromW = state.viewW, fromH = state.viewH;
    const token = ++state.sizeAnimToken;
    const winSize = (w, h) => new LogicalSize(Math.round(w * scale), Math.round(h * scale));

    state.sizeAnimUntil = performance.now() + SIZE_ANIM_MS + 300;
    if (fromW !== toW || fromH !== toH) {
        const t0 = performance.now();
        await new Promise((resolve) => {
            const step = (now) => {
                if (token !== state.sizeAnimToken) return resolve();      // superseded by a newer resize
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
    if (token !== state.sizeAnimToken) return;
    setViewSize(toW, toH);
    await appWindow.setSize(winSize(toW, toH));
    state.sizeAnimUntil = performance.now() + 300;   // ignore the trailing resize events
}