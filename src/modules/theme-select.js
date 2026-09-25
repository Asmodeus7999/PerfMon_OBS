/**
 * theme-select.js — Theme dropdown (Default vertical / Classic horizontal).
 * On change: fades the settings button out, swaps the theme, resizes the window,
 * then fades the settings button back in at its new position.
 */
import { dom, state, THEMES } from './state.js';
import { applyVisibility } from './visibility.js';
import { loadBgOpacity } from './background-opacity.js';

export function initThemeSelect() {
    if (!dom.themeSelect) return;
    dom.themeSelect.value = state.currentTheme;
    let themeSwitchToken = 0;
    const GEAR_FADE_MS = 200;   // matches the settings button's 0.2s opacity transition

    dom.themeSelect.addEventListener('change', async () => {
        const next = THEMES[dom.themeSelect.value] ? dom.themeSelect.value : 'default';
        if (next === state.currentTheme) return;
        const token = ++themeSwitchToken;

        // Settings button: fade out where it is, swap the theme, fade back in at the new spot
        document.body.classList.add('gear-hidden');
        await new Promise((r) => setTimeout(r, GEAR_FADE_MS));
        if (token !== themeSwitchToken) return;

        state.currentTheme = next;
        state.BASE_WIDTH = THEMES[next].width;
        document.body.dataset.theme = next;
        localStorage.setItem('theme', next);
        loadBgOpacity();
        await applyVisibility(); // recomputes size, animates the window, updates backend aspect ratio

        if (token === themeSwitchToken) document.body.classList.remove('gear-hidden');
    });
}
