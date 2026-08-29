# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for PerfMon OBS Overlay server.
#
# Build (on Windows, from the project root, with pyinstaller + websockets installed):
#     pip install pyinstaller websockets
#     pyinstaller server.spec
#
# Output:
#     dist/PerfMonServer/PerfMonServer.exe   (onedir build - fast startup, easy to inspect)
#
# If you'd rather have a single file exe, see the notes at the bottom of this file.

import sys

block_cipher = None

a = Analysis(
    ['afterburner_server.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        # websockets pulls in some submodules dynamically that PyInstaller's
        # static analysis can miss - list them explicitly so the frozen build
        # doesn't fail at runtime with ModuleNotFoundError.
        'websockets',
        'websockets.legacy',
        'websockets.legacy.server',
        'websockets.legacy.client',
        'websockets.asyncio',
        'websockets.asyncio.server',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='PerfMonServer',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    # This is a background service (no GUI window) that just prints status
    # to a console. Set console=False instead if you'd rather it run silently
    # with no window at all (e.g. launched from Start.bat with a hidden window,
    # or auto-started at login).
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # icon='app.ico',   # uncomment and point at an .ico file if you have one
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='PerfMonServer',
)

# -----------------------------------------------------------------------------
# Single-file build (optional)
# -----------------------------------------------------------------------------
# If you want one portable .exe instead of a dist/ folder, replace the EXE(...)
# block above with the version below (and delete/skip the COLLECT block).
# Onefile builds are more convenient to distribute but start a bit slower
# because they unpack to a temp dir on every launch.
#
# exe = EXE(
#     pyz,
#     a.scripts,
#     a.binaries,
#     a.zipfiles,
#     a.datas,
#     [],
#     name='PerfMonServer',
#     debug=False,
#     bootloader_ignore_signals=False,
#     strip=False,
#     upx=True,
#     upx_exclude=[],
#     runtime_tmpdir=None,
#     console=True,
#     disable_windowed_traceback=False,
#     argv_emulation=False,
#     target_arch=None,
#     codesign_identity=None,
#     entitlements_file=None,
#     # icon='app.ico',
# )
