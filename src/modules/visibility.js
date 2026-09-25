/**
 * visibility.js — show/hide cards (CPU/GPU/RAM/FPS) and resize the window to fit.
 */
import { invoke } from '@tauri-apps/api/core';
import { dom, state } from './state.js';
import { calcBaseHeight, windowBaseHeight, syncPanelExpansion, applyViewportSize, animateSize } from './window-size.js';

// Restore saved settings
dom.showCpu.checked = localStorage.getItem('show-cpu') !== 'false';
dom.showGpu.checked = localStorage.getItem('show-gpu') !== 'false';
dom.showRam.checked = localStorage.getItem('show-ram') !== 'false';
dom.showFps.checked = localStorage.getItem('show-fps') !== 'false';

// Safeguard: Ensure at least one monitor is checked (prevent missing window bug)
if (!dom.showCpu.checked && !dom.showGpu.checked && !dom.showRam.checked && !dom.showFps.checked) {
    dom.showCpu.checked = true;
    localStorage.setItem('show-cpu', 'true');
}

/**
 * Apply card visibility based on settings checkboxes.
 * Resizes window height to match remaining cards and enforces minimum of 1 checked monitor.
 */
export async function applyVisibility() {
    const monitors = [
        { el: dom.showCpu, id: 'card-cpu', key: 'show-cpu' },
        { el: dom.showGpu, id: 'card-gpu', key: 'show-gpu' },
        { el: dom.showRam, id: 'card-ram', key: 'show-ram' },
        { el: dom.showFps, id: 'card-fps', key: 'show-fps' },
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
    state.currentBaseHeight = newBaseHeight;
    document.body.style.setProperty('--content-h', `${newBaseHeight}px`);
    syncPanelExpansion();                       // Classic: grow to fit the settings panel if open
    const targetHeight = windowBaseHeight();

    // Notify backend of the new base size for aspect ratio locking during resize dragging
    try {
        await invoke('set_base_size', { width: state.BASE_WIDTH, height: targetHeight });
    } catch (err) {
        console.error('set_base_size error:', err);
    }

    // Glide the viewport + window to the new size
    try {
        const savedScale = parseFloat(localStorage.getItem('app-scale') || '1.0');
        const scale = isNaN(savedScale) ? 1.0 : Math.max(0.6, Math.min(3.0, savedScale));
        await animateSize(state.BASE_WIDTH, targetHeight, scale);
    } catch (err) {
        console.error('Failed to resize window for visibility change:', err);
    }

    // Once the window has shrunk back, un-pin the settings button
    if (!state.panelExpandedHeight) document.body.classList.remove('settings-expanded');
}

function handleMonitorToggle() {
    const checkedCount = [dom.showCpu, dom.showGpu, dom.showRam, dom.showFps].filter(cb => cb.checked).length;
    if (checkedCount === 0) {
        // Prevent unchecking the last remaining monitor
        this.checked = true;
        return;
    }
    applyVisibility();
}

dom.showCpu.addEventListener('change', handleMonitorToggle);
dom.showGpu.addEventListener('change', handleMonitorToggle);
dom.showRam.addEventListener('change', handleMonitorToggle);
dom.showFps.addEventListener('change', handleMonitorToggle);

// Expose for the initial window-persistence setup in main.js
export { applyViewportSize };
