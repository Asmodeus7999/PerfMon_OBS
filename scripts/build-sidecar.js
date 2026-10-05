// ─────────────────────────────────────────────────────────────────────────────
// build-sidecar.js — Builds the LHM sidecar and copies it next to the
// Tauri binary so it can be found at runtime.
//
// Usage:  node scripts/build-sidecar.js
//         npm run build:sidecar
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const rootDir   = resolve('.');
const sidecarDir = join(rootDir, 'sidecar');
const csproj     = join(sidecarDir, 'LhmSidecar.csproj');

if (!existsSync(csproj)) {
    console.error('[ERROR] Sidecar project not found at:', csproj);
    process.exit(1);
}

console.log('\n══════════════════════════════════════════════════');
console.log('  LHM Sidecar Builder');
console.log('══════════════════════════════════════════════════\n');

// 1. Publish self-contained single-file exe
console.log('[1/2] Publishing sidecar (self-contained, single-file)...');
console.log('      This may take a minute on first build...\n');

try {
    execSync(
        `"C:\\Program Files\\dotnet\\dotnet.exe" publish "${csproj}" -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:PublishTrimmed=true`,
        { cwd: sidecarDir, stdio: 'inherit', shell: true }
    );
} catch (err) {
    // Try without full path (if dotnet is on PATH)
    try {
        execSync(
            `dotnet publish "${csproj}" -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:PublishTrimmed=true`,
            { cwd: sidecarDir, stdio: 'inherit', shell: true }
        );
    } catch (err2) {
        console.error('\n[ERROR] Failed to build sidecar. Is .NET SDK installed?');
        process.exit(1);
    }
}

// 2. Copy the published exe to where Tauri's debug/release binary lives
const publishedExe = join(sidecarDir, 'bin', 'Release', 'net9.0-windows', 'win-x64', 'publish', 'lhm-sidecar.exe');

if (!existsSync(publishedExe)) {
    console.error('[ERROR] Published sidecar not found at:', publishedExe);
    process.exit(1);
}

console.log('\n[2/2] Copying sidecar to Tauri target directories...');

// Ensure no old sidecar is running and locking the file
try {
    execSync('taskkill /F /IM lhm-sidecar.exe 2>nul');
    console.log('  (Killed existing sidecar process)');
} catch (e) {
    // Process probably wasn't running, which is fine
}

// Copy to both debug and release directories
const targets = [
    join(rootDir, 'src-tauri', 'target', 'debug'),
    join(rootDir, 'src-tauri', 'target', 'release'),
];

for (const dir of targets) {
    mkdirSync(dir, { recursive: true });
    
    // Copy LHM
    const dest = join(dir, 'lhm-sidecar.exe');
    copyFileSync(publishedExe, dest);
    console.log('  → ' + dest);
    
    // Copy PresentMon
    const presentMonSrc = join(sidecarDir, 'bin', 'PresentMon-2.6.0-x64.exe');
    if (existsSync(presentMonSrc)) {
        const destPm = join(dir, 'PresentMon-x64.exe');
        copyFileSync(presentMonSrc, destPm);
        console.log('  → ' + destPm);
    }
}

console.log('\n══════════════════════════════════════════════════');
console.log('  ✅ Sidecars built and deployed successfully!');
console.log('══════════════════════════════════════════════════\n');
