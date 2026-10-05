import { execSync } from 'child_process';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';

const rootDir = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

console.log('\n══════════════════════════════════════════════════');
console.log('  PerfMon OBS — Clean');
console.log('══════════════════════════════════════════════════\n');

// Kill any running sidecars that may be locking files
for (const proc of ['lhm-sidecar.exe', 'PresentMon-x64.exe', 'perfmon-obs.exe']) {
    try { execSync(`taskkill /F /IM ${proc} 2>nul`); } catch (_) {}
}

// Unload the LHM kernel driver if it's still registered
// LibreHardwareMonitorLib registers its Ring-0 driver as "R0<exename>"
for (const svc of ['R0lhm-sidecar', 'lhm-sidecar', 'WinRing0_1_2_0']) {
    try { execSync(`cmd /c sc stop ${svc}`); } catch (_) {}
    try { execSync(`cmd /c sc delete ${svc}`); } catch (_) {}
}

// Use cargo clean for Rust target (handles locks gracefully)
const cargoToml = join(rootDir, 'src-tauri', 'Cargo.toml');
if (existsSync(join(rootDir, 'src-tauri', 'target'))) {
    console.log('  🗑  Cleaning Rust target/ (cargo clean)...');
    try {
        execSync(`cargo clean --manifest-path "${cargoToml}"`, { stdio: 'inherit' });
    } catch (e) {
        console.warn('  ⚠  cargo clean failed:', e.message);
    }
} else {
    console.log('  ✓  Already clean: Rust target/');
}

// Plain rmSync for everything else
const dirs = [
    { path: join(rootDir, 'dist'),                       label: 'Vite dist/' },
    { path: join(rootDir, 'sidecar', 'bin', 'Release'),  label: '.NET sidecar bin/Release/' },
    { path: join(rootDir, 'sidecar', 'obj'),              label: '.NET sidecar obj/' },
];

for (const { path, label } of dirs) {
    if (existsSync(path)) {
        console.log(`  🗑  Removing ${label}...`);
        rmSync(path, { recursive: true, force: true });
    } else {
        console.log(`  ✓  Already clean: ${label}`);
    }
}

console.log('\n══════════════════════════════════════════════════');
console.log('  ✅ Clean complete!');
console.log('══════════════════════════════════════════════════\n');
