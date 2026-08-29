const ws  = new WebSocket('ws://localhost:8765');
const root = document.getElementById('fps-root');

function findByName(data, name) {
    const lower = name.toLowerCase();
    return data.find(e => e.name.toLowerCase().includes(lower)) || null;
}

ws.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    const data    = payload.sensors ?? payload;

    if (payload.error) { root.innerHTML = `<div class="fps-idle">!</div>`; return; }

    const fpsEntry   = findByName(data, 'framerate');
    const ftimeEntry = findByName(data, 'frametime');

    const fpsVal   = fpsEntry?.value;
    const ftimeVal = ftimeEntry?.value;

    if (fpsVal != null && fpsVal > 0) {
        root.innerHTML = `
            <span class="fps-badge">Framerate</span>
            <span class="fps-number">${Math.round(fpsVal)}</span>
            <span class="fps-unit">FPS</span>
            <div class="fps-divider"></div>
            <span class="ftime-number">${ftimeVal != null ? ftimeVal.toFixed(2) : '--'}</span>
            <span class="ftime-unit">ms / frame</span>
        `;
    } else {
        root.innerHTML = `<div class="fps-idle">—</div>`;
    }
};

ws.onclose = () => {
    root.innerHTML = `<div class="fps-idle">—</div>`;
    setTimeout(() => location.reload(), 5000);
};

ws.onerror = (err) => console.error('FPS WS Error:', err);
