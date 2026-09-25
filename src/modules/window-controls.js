/**
 * window-controls.js — corner resize handles, window scale/position persistence,
 * and the one-time window-size/position restore on startup.
 */
import { invoke } from '@tauri-apps/api/core';
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/window';
import { appWindow, state } from './state.js';
import { calcBaseHeight, windowBaseHeight, applyViewportSize } from './window-size.js';

function updateScaleUI(scale) {
    document.documentElement.style.setProperty('--app-scale', scale);
}

export function initWindowControls() {
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
        if (performance.now() < state.sizeAnimUntil) return;   // our own animated resize — not a user drag
        const scale = Math.min(window.innerWidth / state.BASE_WIDTH, window.innerHeight / windowBaseHeight());
        updateScaleUI(scale);

        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(async () => {
            if (performance.now() < state.sizeAnimUntil) return;
            try {
                const isMax = await appWindow.isMaximized();
                const isMin = await appWindow.isMinimized();
                if (!isMax && !isMin) {
                    const snappedScale = Math.max(0.6, Math.min(3.0, scale));
                    const targetW = Math.round(state.BASE_WIDTH * snappedScale);
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
            state.currentBaseHeight = calcBaseHeight();
            applyViewportSize();
            try {
                await invoke('set_base_size', { width: state.BASE_WIDTH, height: state.currentBaseHeight });
            } catch (_) {}

            // Restore saved scale (default = 1.0)
            const savedScale = parseFloat(localStorage.getItem('app-scale') || '1.0');
            const scale = isNaN(savedScale) ? 1.0 : Math.max(0.6, Math.min(3.0, savedScale));
            const targetW = Math.round(state.BASE_WIDTH * scale);
            const targetH = Math.round(state.currentBaseHeight * scale);
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
}
