/**
 * background-opacity.js — background opacity slider (widget background only;
 * text/values are unaffected). Stored per theme so each theme keeps its own level.
 */
import { dom, state, BG_DEFAULT_PCT } from './state.js';

export function applyBgOpacity(pct) {
    document.body.style.setProperty('--bg-alpha', String(pct / 100));
    if (dom.bgSlider) dom.bgSlider.value = String(pct);
    if (dom.bgSliderVal) dom.bgSliderVal.textContent = `${pct}%`;
}

export function loadBgOpacity() {
    const saved = parseInt(localStorage.getItem(`bg-opacity-${state.currentTheme}`), 10);
    applyBgOpacity(Number.isNaN(saved) ? BG_DEFAULT_PCT[state.currentTheme] : Math.max(0, Math.min(100, saved)));
}

export function initBackgroundOpacity() {
    if (dom.bgSlider) {
        dom.bgSlider.addEventListener('input', () => {
            const pct = parseInt(dom.bgSlider.value, 10);
            applyBgOpacity(pct);
            localStorage.setItem(`bg-opacity-${state.currentTheme}`, String(pct));
        });
    }
    loadBgOpacity();

    // ── Permanent transparent window background ───────────────────────────────
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
}
