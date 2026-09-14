import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync, statSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const rootDir = resolve('.');
const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version || '1.0.0';

console.log(`\n======================================================`);
console.log(`  PerfMon OBS v${version} — Portable ZIP Builder`);
console.log(`======================================================\n`);

// 1. Compile the release binary without bundling installers
console.log(`[1/3] Compiling standalone release executable...`);
execSync('npm run tauri build -- --no-bundle', {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
});

const releaseDir = join(rootDir, 'src-tauri', 'target', 'release');
const exeSource = join(releaseDir, 'perfmon-obs.exe');

if (!existsSync(exeSource)) {
    console.error(`\n[ERROR] Executable not found at: ${exeSource}`);
    process.exit(1);
}

// 2. Prepare staging directory
console.log(`\n[2/3] Staging files for portable package...`);
const bundleDir = join(releaseDir, 'bundle', 'portable');
mkdirSync(bundleDir, { recursive: true });

const zipName = `PerfMon_OBS_${version}_x64_Portable.zip`;
const zipPath = join(bundleDir, zipName);

if (existsSync(zipPath)) {
    rmSync(zipPath, { force: true });
}

const stageDir = join(bundleDir, 'stage');
if (existsSync(stageDir)) {
    rmSync(stageDir, { recursive: true, force: true });
}
mkdirSync(stageDir, { recursive: true });

copyFileSync(exeSource, join(stageDir, 'perfmon-obs.exe'));
const readmePath = join(rootDir, 'README.md');
if (existsSync(readmePath)) {
    copyFileSync(readmePath, join(stageDir, 'README.md'));
}

// 3. Create zip archive
console.log(`[3/3] Creating portable ZIP archive: ${zipName}...`);
try {
    execSync(`tar -a -c -f "${zipPath}" -C "${stageDir}" perfmon-obs.exe README.md`, {
        stdio: 'inherit',
    });
} catch (err) {
    execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipPath}' -Force"`,
        { stdio: 'inherit' }
    );
}

// Clean up temporary stage directory
rmSync(stageDir, { recursive: true, force: true });

const sizeMB = (statSync(zipPath).size / (1024 * 1024)).toFixed(2);
console.log(`\n======================================================`);
console.log(`  SUCCESS: Portable ZIP created!`);
console.log(`  File: ${zipPath}`);
console.log(`  Size: ${sizeMB} MB`);
console.log(`======================================================\n`);
