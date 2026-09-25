/**
 * click-through.js — pass mouse clicks to windows/games beneath the overlay.
 * Holding Right-Alt temporarily bypasses click-through so you can reach the UI.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appWindow, dom, state } from './state.js';
import { applyVisibility } from './visibility.js';

let lastBypassSeq = 0;

async function setClickthrough(enabled) {
    try {
        if (!enabled) {
            document.body.classList.remove('clickthrough-bypassed');
        }
        await appWindow.setIgnoreCursorEvents(enabled);
        await invoke('set_clickthrough_active', { active: enabled });
        if (dom.clickthroughToggle) dom.clickthroughToggle.checked = enabled;
        localStorage.setItem('click-through', enabled);
        if (enabled && dom.settingsPanel && !dom.settingsPanel.classList.contains('hidden')) {
            dom.settingsPanel.classList.add('hidden');
            if (dom.settingsBtn) dom.settingsBtn.classList.remove('active');
            document.body.classList.add('settings-expanding');
            applyVisibility().finally(() => {
                document.body.classList.remove('settings-expanding');
            });
        }
    } catch (err) {
        console.error('Failed to set click-through:', err);
    }
}

export function initClickThrough() {
    // Restore saved click-through setting (default = false)
    const initialClickthrough = localStorage.getItem('click-through') === 'true';
    if (dom.clickthroughToggle) {
        dom.clickthroughToggle.checked = initialClickthrough;
        if (initialClickthrough) {
            setClickthrough(true);
        }
        dom.clickthroughToggle.addEventListener('change', () => {
            setClickthrough(dom.clickthroughToggle.checked);
        });
    }

    // Listen for Right-Alt bypass event from Rust backend
    listen('bypass-clickthrough', async (event) => {
        const isBypassing = Boolean(event.payload);
        const seq = ++lastBypassSeq;

        // 1. Immediately update visual glow synchronously to prevent async race conditions
        if (!isBypassing || !dom.clickthroughToggle || !dom.clickthroughToggle.checked) {
            document.body.classList.remove('clickthrough-bypassed');
        } else {
            document.body.classList.add('clickthrough-bypassed');
        }

        // 2. Apply window cursor event pass-through
        if (dom.clickthroughToggle && dom.clickthroughToggle.checked) {
            try {
                await appWindow.setIgnoreCursorEvents(!isBypassing);
            } catch (err) {
                console.error('Failed to update bypass state:', err);
            }
        }

        // 3. Stale sequence check: if a newer event arrived while awaiting, do not overwrite
        if (seq !== lastBypassSeq) return;

        if (!isBypassing || !dom.clickthroughToggle || !dom.clickthroughToggle.checked) {
            document.body.classList.remove('clickthrough-bypassed');
        } else {
            document.body.classList.add('clickthrough-bypassed');
        }
    }).catch(err => console.error('Failed to listen to bypass-clickthrough:', err));

    // Safety fallback: if Alt is released while window has focus, immediately clear glow
    window.addEventListener('keyup', (e) => {
        if (e.key === 'Alt' || e.code === 'AltRight' || e.code === 'AltLeft') {
            document.body.classList.remove('clickthrough-bypassed');
            if (dom.clickthroughToggle && dom.clickthroughToggle.checked) {
                appWindow.setIgnoreCursorEvents(true).catch(() => {});
            }
        }
    });

    // Safety fallback: if window blurs, ensure no stuck glow
    window.addEventListener('blur', () => {
        if (!dom.clickthroughToggle || !dom.clickthroughToggle.checked) {
            document.body.classList.remove('clickthrough-bypassed');
        }
    });
}
