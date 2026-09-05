import os
import threading
import http.server
import socketserver
import ctypes
import multiprocessing
import winreg
from ctypes import wintypes
import json
import asyncio
import websockets
import math
import re

# --- WinAPI setup ---
kernel32 = ctypes.windll.kernel32
kernel32.OpenFileMappingW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
kernel32.OpenFileMappingW.restype = wintypes.HANDLE
kernel32.MapViewOfFile.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_size_t]
kernel32.MapViewOfFile.restype = wintypes.LPVOID
kernel32.UnmapViewOfFile.argtypes = [wintypes.LPCVOID]
kernel32.UnmapViewOfFile.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL

# -- RTSS Shared Memory (for FPS + Frame Time) --------------------------------
# Based on: RivaTuner Statistics Server SDK RTSSSharedMemory.h

RTSS_SHM_NAME  = "RTSSSharedMemoryV2"
RTSS_SIGNATURE = 0x53535452   # 'RTSS'

class RTSS_SHARED_MEMORY_HEADER(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ("dwSignature",    ctypes.c_uint32),   # 0x53535452 = 'RTSS'
        ("dwVersion",      ctypes.c_uint32),
        ("dwAppEntrySize", ctypes.c_uint32),   # size of each process entry
        ("dwAppArrOffset", ctypes.c_uint32),   # byte offset to process array
        ("dwAppArrSize",   ctypes.c_uint32),   # number of process slots
        ("dwOSDEntrySize", ctypes.c_uint32),
        ("dwOSDArrOffset", ctypes.c_uint32),
        ("dwOSDArrSize",   ctypes.c_uint32),
        ("dwOSDFrame",     ctypes.c_uint32),
    ]

class RTSS_SHARED_MEMORY_ENTRY(ctypes.Structure):
    """One slot per monitored process in the RTSS shared memory map."""
    _pack_ = 1
    _fields_ = [
        ("dwProcessID",  ctypes.c_uint32),        # PID  (0 = empty slot)
        ("szName",       ctypes.c_char * 260),    # process name
        ("dwFlags",      ctypes.c_uint32),
        ("dwTime0",      ctypes.c_uint32),        # internal timing counters
        ("dwTime1",      ctypes.c_uint32),
        ("dwFrames",     ctypes.c_uint32),        # frames since last sample
        ("dwFrameTime",  ctypes.c_uint32),        # last frame time in microseconds
        ("dwCurrentFPS", ctypes.c_uint32),        # current FPS x1000
        ("dwAverageFPS", ctypes.c_uint32),        # average FPS x1000
        ("dwMinFPS",     ctypes.c_uint32),        # min FPS x1000
        ("dwMaxFPS",     ctypes.c_uint32),        # max FPS x1000
    ]

class RTSSReader:
    FILE_MAP_READ = 0x0004

    def __init__(self):
        self.handle = None
        self.ptr    = None

    def connect(self):
        self.handle = kernel32.OpenFileMappingW(self.FILE_MAP_READ, False, RTSS_SHM_NAME)
        if not self.handle:
            return False
        self.ptr = kernel32.MapViewOfFile(self.handle, self.FILE_MAP_READ, 0, 0, 0)
        if not self.ptr:
            kernel32.CloseHandle(self.handle)
            self.handle = None
            return False
        return True

    def disconnect(self):
        if self.ptr:
            kernel32.UnmapViewOfFile(self.ptr)
            self.ptr = None
        if self.handle:
            kernel32.CloseHandle(self.handle)
            self.handle = None

    def get_fps_data(self):
        """Return dict with fps and frame_time_ms for the active game, or None."""
        if not self.ptr and not self.connect():
            return None
        try:
            hdr = RTSS_SHARED_MEMORY_HEADER.from_address(self.ptr)
            if hdr.dwSignature != RTSS_SIGNATURE:
                self.disconnect()
                return None

            # Pick the slot with the highest active FPS (= foreground game)
            best_fps   = 0
            best_ftime = 0
            for i in range(hdr.dwAppArrSize):
                addr = self.ptr + hdr.dwAppArrOffset + i * hdr.dwAppEntrySize
                e = RTSS_SHARED_MEMORY_ENTRY.from_address(addr)
                if e.dwProcessID == 0:
                    continue
                if e.dwCurrentFPS > best_fps:
                    best_fps   = e.dwCurrentFPS
                    best_ftime = e.dwFrameTime

            return {
                "fps":           round(best_fps   / 1000.0, 1),
                "frame_time_ms": round(best_ftime / 1000.0, 2),
            }
        except Exception as e:
            print(f"RTSS read error: {e}")
            self.disconnect()
            return None

# --- MSI Afterburner MAHM Shared Memory Structures ---
# Based on: C:\Program Files (x86)\MSI Afterburner\SDK\Include\MAHMSharedMemory.h

MAX_PATH = 260
MAHM_SIGNATURE = 0x4D41484D   # 'MAHM'
MAHM_VERSION_2 = 0x00020000
FLT_MAX        = 3.402823466e+38  # Value used by Afterburner when data is unavailable

class MAHM_SHARED_MEMORY_HEADER(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ("dwSignature",    ctypes.c_uint32),  # 0x4D41484D = 'MAHM'
        ("dwVersion",      ctypes.c_uint32),  # 0x00020000 for v2.0
        ("dwHeaderSize",   ctypes.c_uint32),  # size of this header
        ("dwNumEntries",   ctypes.c_uint32),  # number of MAHM_SHARED_MEMORY_ENTRY entries
        ("dwEntrySize",    ctypes.c_uint32),  # size of each entry
        ("time",           ctypes.c_int32),   # last polling time (__time32_t)
        # v2.0+ fields:
        ("dwNumGpuEntries",ctypes.c_uint32),  # number of GPU info entries
        ("dwGpuEntrySize", ctypes.c_uint32),  # size of each GPU info entry
    ]

class MAHM_SHARED_MEMORY_ENTRY(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ("szSrcName",            ctypes.c_char * MAX_PATH),  # e.g. "GPU temperature"
        ("szSrcUnits",           ctypes.c_char * MAX_PATH),  # e.g. "°C"
        ("szLocalizedSrcName",   ctypes.c_char * MAX_PATH),
        ("szLocalizedSrcUnits",  ctypes.c_char * MAX_PATH),
        ("szRecommendedFormat",  ctypes.c_char * MAX_PATH),  # e.g. "%.0f"
        ("data",                 ctypes.c_float),             # current value (FLT_MAX = unavailable)
        ("minLimit",             ctypes.c_float),
        ("maxLimit",             ctypes.c_float),
        ("dwFlags",              ctypes.c_uint32),
        ("dwGpu",                ctypes.c_uint32),            # GPU index, 0xFFFFFFFF = global
        ("dwSrcId",              ctypes.c_uint32),            # sensor type ID constant
    ]

# --- Windows system info helpers ---
# Note: MAHM GPU entries are read as raw bytes (see get_data) because
# Afterburner's dwGpuEntrySize may differ from a fixed ctypes struct size.

def _get_cpu_name() -> str:
    """Read the CPU brand string from the Windows registry."""
    try:
        key = winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0"
        )
        name, _ = winreg.QueryValueEx(key, "ProcessorNameString")
        winreg.CloseKey(key)
        
        # Clean up common trademark symbols and clock speed
        name = name.replace("(R)", "").replace("(r)", "")
        name = name.replace("(TM)", "").replace("(tm)", "")
        name = name.replace("CPU", "")
        # Remove trailing "@ X.XXGHz"
        name = re.sub(r'@\s*[\d\.]+\s*[Gg][Hh][Zz]', '', name)
        
        # Collapse extra whitespace (some OEMs pad the string)
        return " ".join(name.split())
    except Exception:
        return "CPU"

def _get_ram_type() -> str:
    """Read RAM type via PowerShell WMI (SMBIOSMemoryType)."""
    import subprocess
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Get-CimInstance Win32_PhysicalMemory | Select-Object -ExpandProperty SMBIOSMemoryType"],
            capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW
        )
        if result.stdout:
            for line in result.stdout.split():
                if line.strip().isdigit():
                    code = int(line.strip())
                    if code == 20: return "DDR"
                    if code == 21: return "DDR2"
                    if code == 24: return "DDR3"
                    if code == 26: return "DDR4"
                    if code == 34: return "DDR5"
                    if code == 35: return "LPDDR5"
                    return f"RAM"
        return "RAM"
    except Exception:
        return "RAM"

def _get_total_ram_gb() -> float:
    """Return total physical RAM in GB via GlobalMemoryStatusEx."""
    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength",                ctypes.c_ulong),
            ("dwMemoryLoad",            ctypes.c_ulong),
            ("ullTotalPhys",            ctypes.c_ulonglong),
            ("ullAvailPhys",            ctypes.c_ulonglong),
            ("ullTotalPageFile",        ctypes.c_ulonglong),
            ("ullAvailPageFile",        ctypes.c_ulonglong),
            ("ullTotalVirtual",         ctypes.c_ulonglong),
            ("ullAvailVirtual",         ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]
    stat = MEMORYSTATUSEX()
    stat.dwLength = ctypes.sizeof(stat)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
    return stat.ullTotalPhys / (1024 ** 3)

def _get_dedicated_vram_gb(adapter_index: int = 0) -> float | None:
    """Read dedicated VRAM from the Windows display adapter registry key.

    HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-...}\\000x
    HardwareInformation.MemorySize  (QWORD, bytes)  → dedicated VRAM only.
    This is more reliable than WMI AdapterRAM (uint32 overflow) or MAHM
    dwMemAmount (zero on AMD).
    """
    import struct
    DISPLAY_CLASS = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
    try:
        key = winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            f"{DISPLAY_CLASS}\\{adapter_index:04d}"
        )
        raw, reg_type = winreg.QueryValueEx(key, "HardwareInformation.MemorySize")
        winreg.CloseKey(key)
        # The value is a REG_BINARY (8-byte little-endian QWORD) or REG_QWORD
        if isinstance(raw, bytes):
            padded = raw.ljust(8, b"\x00")[:8]
            mem_bytes = struct.unpack("<Q", padded)[0]
        else:
            mem_bytes = int(raw)  # REG_QWORD already decoded by winreg
        return mem_bytes / (1024 ** 3)
    except Exception:
        return None

# --- Afterburner Reader ---

class AfterburnerReader:
    SHM_NAME     = "MAHMSharedMemory"
    FILE_MAP_READ = 0x0004

    def __init__(self):
        self.handle        = None
        self.ptr           = None
        self._was_connected = False  # Track state to suppress repeated messages
        self._sig_error_shown = False

    def connect(self):
        try:
            self.handle = kernel32.OpenFileMappingW(self.FILE_MAP_READ, False, self.SHM_NAME)
            if not self.handle:
                if self._was_connected:
                    # Only warn once when Afterburner disappears
                    print("[Afterburner] Shared memory lost. Is MSI Afterburner still running?")
                    self._was_connected = False
                return False

            self.ptr = kernel32.MapViewOfFile(self.handle, self.FILE_MAP_READ, 0, 0, 0)
            if not self.ptr:
                print(f"[Afterburner] MapViewOfFile failed. Error: {ctypes.GetLastError()}")
                kernel32.CloseHandle(self.handle)
                self.handle = None
                return False

            header = MAHM_SHARED_MEMORY_HEADER.from_address(self.ptr)
            if header.dwSignature != MAHM_SIGNATURE:
                if not self._sig_error_shown:
                    print(f"[Afterburner] Invalid MAHM signature: {hex(header.dwSignature)}. Expected {hex(MAHM_SIGNATURE)}. (Waiting for Afterburner to initialize...)")
                    self._sig_error_shown = True
                self.disconnect()
                return False
            
            self._sig_error_shown = False

            v_major = header.dwVersion >> 16
            v_minor = header.dwVersion & 0xFFFF
            print(f"[Afterburner] Connected to shared memory v{v_major}.{v_minor}")
            print(f"  Entries: {header.dwNumEntries}  |  Entry size: {header.dwEntrySize} bytes")
            self._was_connected = True
            return True
        except Exception as e:
            print(f"[Afterburner] Error connecting: {e}")
            self.disconnect()
            return False

    def disconnect(self):
        if self.ptr:
            kernel32.UnmapViewOfFile(self.ptr)
            self.ptr = None
        if self.handle:
            kernel32.CloseHandle(self.handle)
            self.handle = None

    def _is_valid(self, value: float) -> bool:
        """Return False if the value is FLT_MAX (unavailable) or NaN/Inf."""
        return value < FLT_MAX * 0.9 and not math.isnan(value) and not math.isinf(value)

    def get_data(self):
        """Return (sensors_list, gpu_info_list) or (None, None) on failure."""
        if not self.ptr:
            if not self.connect():
                return None, None
        try:
            header = MAHM_SHARED_MEMORY_HEADER.from_address(self.ptr)
            if header.dwSignature != MAHM_SIGNATURE:
                self.disconnect()
                return None, None

            # --- Sensor entries ---
            entries = []
            base = self.ptr + header.dwHeaderSize

            for i in range(header.dwNumEntries):
                e = MAHM_SHARED_MEMORY_ENTRY.from_address(base + i * header.dwEntrySize)
                value = e.data
                entries.append({
                    "name":  e.szSrcName.decode("utf-8", errors="ignore").rstrip("\x00"),
                    "units": e.szSrcUnits.decode("utf-8", errors="ignore").rstrip("\x00"),
                    "value": round(float(value), 2) if self._is_valid(value) else None,
                    "gpu":   e.dwGpu,
                    "srcId": e.dwSrcId,
                })

            # --- GPU info entries (v2.0+): names from shared memory, VRAM from Windows registry ---
            # Note: dwMemAmount in the GPU entry block is zero on AMD cards. We use
            # HardwareInformation.MemorySize from the display adapter registry key instead,
            # which always contains the dedicated (physical) VRAM in bytes.

            gpu_infos = []
            if header.dwNumGpuEntries and header.dwGpuEntrySize:
                gpu_base = self.ptr + header.dwHeaderSize + header.dwNumEntries * header.dwEntrySize
                entry_sz  = header.dwGpuEntrySize
                OFF_DEVICE = MAX_PATH * 2   # 520
                OFF_FAMILY = MAX_PATH * 1   # 260

                for i in range(header.dwNumGpuEntries):
                    entry_addr = gpu_base + i * entry_sz
                    raw        = (ctypes.c_char * entry_sz).from_address(entry_addr)
                    raw_bytes  = bytes(raw)

                    def _str(offset, _rb=raw_bytes):
                        chunk = _rb[offset: offset + MAX_PATH]
                        return chunk.split(b"\x00", 1)[0].decode("utf-8", errors="ignore")

                    device = _str(OFF_DEVICE)
                    family = _str(OFF_FAMILY)

                    # Total VRAM: read dedicated VRAM from Windows display adapter registry.
                    # This avoids MAHM's dwMemAmount (zero on AMD) and sensor maxLimit
                    # (which may include shared memory on some systems).
                    vram_raw = _get_dedicated_vram_gb(i)
                    vram_gb  = round(vram_raw, 1) if vram_raw else None

                    gpu_infos.append({
                        "index":   i,
                        "device":  device,
                        "family":  family,
                        "vram_gb": vram_gb,
                    })

            return entries, gpu_infos

        except ValueError as e:
            print(f"Memory read error (Afterburner may have restarted): {e}")
            self.disconnect()
            global _system_info_cache
            _system_info_cache = None  # Force refresh on next connect
            return None, None
        except Exception as e:
            print(f"Unexpected error reading Afterburner memory: {e}")
            self.disconnect()
            _system_info_cache = None
            return None, None

# --- WebSocket Server ---

CLIENTS = set()
reader = AfterburnerReader()

async def client_handler(websocket):
    CLIENTS.add(websocket)
    print(f"Client connected: {websocket.remote_address} | Total clients: {len(CLIENTS)}")
    try:
        await websocket.wait_closed()
    finally:
        CLIENTS.remove(websocket)
        print(f"Client disconnected. Total clients: {len(CLIENTS)}")

# Cache system info so we don't re-read it every second
_system_info_cache: dict | None = None

def _build_system_info(gpu_infos: list) -> dict:
    """Assemble static hardware info from OS APIs + Afterburner GPU entries.
    Defers caching until all GPU VRAM values are available."""
    global _system_info_cache
    if _system_info_cache is not None:
        return _system_info_cache

    # Don't cache yet if any GPU still has no VRAM reading
    if gpu_infos and any(g["vram_gb"] is None for g in gpu_infos):
        return {
            "cpu_name": _get_cpu_name(),
            "ram_gb":   round(_get_total_ram_gb()),
            "gpus":     gpu_infos,
        }

    cpu_name   = _get_cpu_name()
    ram_gb_int = round(_get_total_ram_gb())
    ram_type   = _get_ram_type()

    _system_info_cache = {
        "cpu_name":  cpu_name,
        "ram_gb":    ram_gb_int,
        "ram_type":  ram_type,
        "gpus":      gpu_infos,
    }
    print(f"[SystemInfo] CPU: {cpu_name}  |  RAM: {ram_gb_int} GB {ram_type}")
    for g in gpu_infos:
        print(f"[SystemInfo] GPU[{g['index']}]: {g['device']}  |  VRAM: {g['vram_gb']} GB")
    return _system_info_cache

async def data_loop():
    while True:
        try:
            if CLIENTS:
                sensors, gpu_infos = reader.get_data()
                if sensors is not None:
                    sys_info = _build_system_info(gpu_infos)
                    payload  = json.dumps({"sensors": sensors, "system_info": sys_info})
                else:
                    payload = json.dumps({"error": "MSI Afterburner not found. Is it running?"})

                # Send to all connected clients
                for client in list(CLIENTS):
                    try:
                        await client.send(payload)
                    except websockets.exceptions.ConnectionClosed:
                        pass

            await asyncio.sleep(1)
        except Exception as e:
            print(f"Error in data loop: {e}")
            await asyncio.sleep(2)

def optimize_process_impact():
    """Sets BELOW_NORMAL priority and disables Core 0 usage natively on Windows."""
    if os.name != 'nt':
        return

    try:
        kernel32 = ctypes.windll.kernel32
        process_handle = kernel32.GetCurrentProcess()
        
        # 1. Set to BELOW_NORMAL priority (0x00004000)
        BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
        kernel32.SetPriorityClass(process_handle, BELOW_NORMAL_PRIORITY_CLASS)
        
        print("Hardware optimizations applied: BELOW_NORMAL priority.")
    except Exception as e:
        print(f"Notice: Could not set process optimization: {e}")

def start_http_server(port=8000, directory_name="overlay"):
    import sys
    
    # Handle PyInstaller paths
    if hasattr(sys, '_MEIPASS'):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(os.path.abspath(__file__))
        
    directory = os.path.join(base_path, directory_name)
    
    # Fallback to current directory if not found
    if not os.path.exists(directory):
        directory = "."

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)
        
        def log_message(self, format, *args):
            # Suppress HTTP logging to avoid console spam
            pass

    socketserver.TCPServer.allow_reuse_address = True
    try:
        httpd = socketserver.TCPServer(("", port), Handler)
        print(f"Starting HTTP Server on http://localhost:{port} (Serving '{directory}' folder)")
        httpd.serve_forever()
    except Exception as e:
        print(f"Failed to start HTTP server on port {port}: {e}")

async def main():
    optimize_process_impact()
    
    # Start the HTTP Server in a background thread
    http_thread = threading.Thread(target=start_http_server, args=(8000, "overlay"), daemon=True)
    http_thread.start()
    
    print("Starting MSI Afterburner WebSocket Server on ws://localhost:8765...")
    print("Make sure MSI Afterburner is running (OSD can be off).")
    
    try:
        async with websockets.serve(client_handler, "localhost", 8765):
            await data_loop()
    finally:
        reader.disconnect()

if __name__ == "__main__":
    asyncio.run(main())
