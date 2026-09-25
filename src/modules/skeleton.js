/**
 * skeleton.js — builds the overlay's DOM skeleton and renders sensor values into it.
 */
import { state, dom } from './state.js';
import { applyVisibility } from './visibility.js';

// ── Static stat-box definitions ───────────────────────────────────────────────
const STAT_DEFS = [
    { id: 'cpu-temp',   unit: '°C',  label: 'Temp',       widthClass: 'sw-3d' },
    { id: 'cpu-load',   unit: '%',   label: 'Load',       widthClass: 'sw-3d' },
    { id: 'cpu-power',  unit: 'W',   label: 'Power',      widthClass: 'sw-3d' },
    { id: 'cpu-clock',  unit: 'MHz', label: 'Clock',      widthClass: 'sw-4d' },
    { id: 'gpu-temp',   unit: '°C',  label: 'Temp',       widthClass: 'sw-3d' },
    { id: 'gpu-load',   unit: '%',   label: 'Load',       widthClass: 'sw-3d' },
    { id: 'gpu-power',  unit: 'W',   label: 'Power',      widthClass: 'sw-3d' },
    { id: 'gpu-clock',  unit: 'MHz', label: 'Clock',      widthClass: 'sw-4d' },
    { id: 'ram-usage',  unit: 'MB',  label: 'System RAM', widthClass: 'sw-5d' },
    { id: 'vram-usage', unit: 'MB',  label: 'VRAM',       widthClass: 'sw-5d' },
    { id: 'fps',        unit: 'FPS', label: 'Framerate',  widthClass: 'sw-3d' },
    { id: 'ftime',      unit: 'ms',  label: 'Frametime',  widthClass: 'sw-4d' },
];

function statBoxSkeleton({ id, unit, label, widthClass }) {
    return `
        <div class="stat-box ${widthClass}" id="box-${id}">
            <div class="stat-val-row">
                <span class="stat-val" id="val-${id}">–</span>
                <span class="stat-unit" id="unit-${id}">${unit}</span>
            </div>
            <span class="stat-label">${label}</span>
        </div>`;
}

const byId = (id) => STAT_DEFS.find(s => s.id === id);

export function buildSkeleton() {
    dom.container.innerHTML = `
        <div class="osd-root">
            <div class="card card-cpu theme-default" id="card-cpu">
                <div class="card-header">
                    <div class="card-dot themed-dot"></div>
                    <span class="card-name themed-color">CPU</span>
                    <span class="card-short themed-color" id="cpu-short"></span>
                    <span class="card-subtitle" id="cpu-subtitle"></span>
                </div>
                <div class="stats-row">
                    ${statBoxSkeleton(byId('cpu-temp'))}
                    ${statBoxSkeleton(byId('cpu-load'))}
                    ${statBoxSkeleton(byId('cpu-power'))}
                    ${statBoxSkeleton(byId('cpu-clock'))}
                </div>
            </div>

            <div class="card card-gpu theme-default" id="card-gpu">
                <div class="card-header">
                    <div class="card-dot themed-dot"></div>
                    <span class="card-name themed-color">GPU</span>
                    <span class="card-short themed-color" id="gpu-short"></span>
                    <span class="card-subtitle" id="gpu-subtitle"></span>
                </div>
                <div class="stats-row">
                    ${statBoxSkeleton(byId('gpu-temp'))}
                    ${statBoxSkeleton(byId('gpu-load'))}
                    ${statBoxSkeleton(byId('gpu-power'))}
                    ${statBoxSkeleton(byId('gpu-clock'))}
                </div>
            </div>

            <div class="card card-ram" id="card-ram">
                <div class="card-header">
                    <div class="card-dot ram-dot"></div>
                    <span class="card-name ram-color">RAM</span>
                    <span class="card-subtitle" id="ram-subtitle"></span>
                </div>
                <div class="stats-row">
                    ${statBoxSkeleton(byId('ram-usage'))}
                    ${statBoxSkeleton(byId('vram-usage'))}
                </div>
            </div>

            <div class="card card-fps" id="card-fps">
                <div class="card-header">
                    <div class="card-dot fps-dot"></div>
                    <span class="card-name fps-color">FPS</span>
                </div>
                <div class="stats-row">
                    ${statBoxSkeleton(byId('fps'))}
                    ${statBoxSkeleton(byId('ftime'))}
                </div>
            </div>
        </div>`;

    state.els = {
        cpuCard:     document.getElementById('card-cpu'),
        gpuCard:     document.getElementById('card-gpu'),
        ramCard:     document.getElementById('card-ram'),
        fpsCard:     document.getElementById('card-fps'),
        cpuShort:    document.getElementById('cpu-short'),
        gpuShort:    document.getElementById('gpu-short'),
        cpuSubtitle: document.getElementById('cpu-subtitle'),
        gpuSubtitle: document.getElementById('gpu-subtitle'),
        ramSubtitle: document.getElementById('ram-subtitle'),
    };
    for (const def of STAT_DEFS) {
        state.els[def.id] = {
            box:  document.getElementById(`box-${def.id}`),
            val:  document.getElementById(`val-${def.id}`),
            unit: document.getElementById(`unit-${def.id}`),
        };
    }
    state.built = true;

    applyVisibility();
}

export function setStat(id, entry, unitOverride) {
    // Classic theme shows power with one decimal (e.g. 37.6 W), like Afterburner
    const dec = (state.currentTheme === 'classic' && id.endsWith('-power')) ? 1 : 0;
    const v = (entry && entry.value !== null && entry.value !== undefined)
        ? (dec > 0 ? Number(entry.value.toFixed(dec)) : Math.round(entry.value))
        : null;
    const ref = state.els[id];
    if (!ref) return;
    ref.box.style.opacity = v === null ? '0.2' : '';
    ref.val.textContent   = v !== null ? v : '–';
    if (unitOverride !== undefined && ref.unit.textContent !== unitOverride) {
        ref.unit.textContent = unitOverride;
    }
}

export function setFpsStat(id, value, decimals = 0) {
    const ref = state.els[id];
    if (!ref) return;
    if (value == null || value <= 0) {
        ref.box.style.opacity = '0.2';
        ref.val.textContent   = '–';
    } else {
        ref.box.style.opacity = '';
        ref.val.textContent   = decimals > 0 ? value.toFixed(decimals) : Math.round(value);
    }
}

export function getThemeClass(label) {
    const l = (label || '').toLowerCase();
    if (l.includes('intel') || l.includes('arc'))                                    return 'theme-intel';
    if (l.includes('amd')   || l.includes('radeon') || l.includes('ryzen'))          return 'theme-amd';
    if (l.includes('nvidia')|| l.includes('geforce')|| l.includes('rtx') || l.includes('gtx')) return 'theme-nvidia';
    return 'theme-default';
}

const THEME_CLASSES = ['theme-intel', 'theme-amd', 'theme-nvidia', 'theme-default'];
export function applyTheme(cardEl, themeClass) {
    if (!cardEl || cardEl.classList.contains(themeClass)) return;
    cardEl.classList.remove(...THEME_CLASSES);
    cardEl.classList.add(themeClass);
}

// Short labels for the Classic theme, e.g. "Intel Core i5-4690" → "i5-4690",
// "AMD Radeon RX 580 Series" → "RX580".
export function shortCpuName(name) {
    const n = name || '';
    let m = n.match(/\bi[3579]-\w+/i);
    if (m) return m[0];
    m = n.match(/Ultra\s*([3579])\s*(\w+)/i);
    if (m) return `U${m[1]} ${m[2]}`;
    m = n.match(/Ryzen\s*(?:Threadripper\s*)?([3579])?\s*(\d{3,4}\w*)/i);
    if (m) return m[1] ? `R${m[1]} ${m[2]}` : m[2];
    const cleaned = n.replace(/\b(Intel|AMD|Core|Processor|with|Radeon|Graphics)\b/gi, '')
                     .replace(/\s+/g, ' ').trim();
    return (cleaned || 'CPU').slice(0, 10);
}

export function shortGpuName(name) {
    const n = name || '';
    let m = n.match(/\b(RTX|GTX|GT|RX)\s*(\d{3,4})\s*(Ti\s*SUPER|Ti|SUPER|XTX|XT|GRE)?/i);
    if (m) return `${m[1].toUpperCase()}${m[2]}${m[3] ? m[3].replace(/\s+/g, '') : ''}`;
    m = n.match(/Arc\s*(?:Pro\s*)?([AB]\d{3}\w*)/i);
    if (m) return `Arc ${m[1]}`;
    const cleaned = n.replace(/\((R|TM)\)/gi, '').replace(/\b(NVIDIA|AMD|Intel|GeForce|Radeon|Graphics|Series)\b/gi, '')
                     .replace(/\s+/g, ' ').trim();
    return (cleaned || 'GPU').slice(0, 10);
}

export function setSubtitleIfChanged(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
}
