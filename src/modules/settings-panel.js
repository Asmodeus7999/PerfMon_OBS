/**
 * settings-panel.js — the gear button: click to toggle the settings panel, or
 * press-and-hold / drag to move the window. Also wires Always-on-Top and the
 * panel's minimize/close buttons.
 */
import { appWindow, dom } from './state.js';
import { applyVisibility } from './visibility.js';

export function toggleSettings() {
    if (!dom.settingsPanel) return;
    const isHidden = dom.settingsPanel.classList.toggle('hidden');
    if (dom.settingsBtn) {
        dom.settingsBtn.classList.toggle('active', !isHidden);
    }
    document.body.classList.add('settings-expanding');   // hide the panel's scrollbar mid-resize
    applyVisibility().finally(() => {                     // Classic: grow/shrink window to fit the panel
        document.body.classList.remove('settings-expanding');
    });
}

export function initSettingsPanel() {
    // ── Always on Top ───────────────────────────────────────────────────────
    dom.aotToggle.checked = localStorage.getItem('always-on-top') === 'true'; // off by default
    appWindow.setAlwaysOnTop(dom.aotToggle.checked);

    dom.aotToggle.addEventListener('change', () => {
        appWindow.setAlwaysOnTop(dom.aotToggle.checked);
        localStorage.setItem('always-on-top', dom.aotToggle.checked);
    });

    // ── Settings button toggle & dragging ──────────────────────────────────
    let isMouseDownOnSettings = false;
    let startX = 0;
    let startY = 0;
    let hasDragged = false;
    let dragTimer = null;

    if (dom.settingsBtn && dom.settingsPanel) {
        dom.settingsBtn.addEventListener('mousedown', (e) => {
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

        dom.settingsBtn.addEventListener('click', (e) => {
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

    // ── Window controls (in settings dropdown) ─────────────────────────────
    if (dom.btnMinimize) {
        dom.btnMinimize.addEventListener('click', () => {
            appWindow.minimize();
        });
    }

    if (dom.btnClose) {
        dom.btnClose.addEventListener('click', () => {
            appWindow.close();
        });
    }
}
