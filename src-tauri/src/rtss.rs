// ─────────────────────────────────────────────────────────────────────────────
// rtss.rs — RivaTuner Statistics Server shared-memory FPS reader
//
// Ported from the RTSSReader class in afterburner_server.py.
// Reads RTSSSharedMemoryV2 to get current FPS + frametime for the
// foreground game (the entry with the highest active FPS).
// ─────────────────────────────────────────────────────────────────────────────

use std::ptr;
use serde::Serialize;

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::Memory::{MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ, MEMORY_MAPPED_VIEW_ADDRESS},
};

const RTSS_SIGNATURE: u32 = 0x53535452; // 'RTSS'
const RTSS_SHM_NAME: &str = "RTSSSharedMemoryV2";

// ── RTSSSharedMemoryV2 header field offsets (all u32, 4 bytes each, packed) ──
//   0   dwSignature     4
//   4   dwVersion       4
//   8   dwAppEntrySize  4   ← size of each process entry in the array
//  12   dwAppArrOffset  4   ← byte offset from start of block to entry array
//  16   dwAppArrSize    4   ← number of entry slots
//  20   dwOSDEntrySize  4
//  24   dwOSDArrOffset  4
//  28   dwOSDArrSize    4
//  32   dwOSDFrame      4
struct RTSSHeader;
#[allow(dead_code)]
impl RTSSHeader {
    const OFF_SIGNATURE:      usize = 0;
    const OFF_APP_ENTRY_SIZE: usize = 8;
    const OFF_APP_ARR_OFFSET: usize = 12;
    const OFF_APP_ARR_SIZE:   usize = 16;
}

// ── RTSS process entry field offsets ─────────────────────────────────────────
//   0    dwProcessID     u32  (0 = empty slot)
//   4    szName          char[260]
// 264    dwFlags         u32
// 268    dwTime0         u32
// 272    dwTime1         u32
// 276    dwFrames        u32
// 280    dwFrameTime     u32  (last frame time in microseconds)
// 284    dwCurrentFPS    u32  (current FPS × 1000)
// 288    dwAverageFPS    u32
// 292    dwMinFPS        u32
// 296    dwMaxFPS        u32
struct RTSSEntry;
impl RTSSEntry {
    const OFF_PROCESS_ID:  usize = 0;
    const OFF_FRAME_TIME:  usize = 280;
    const OFF_CURRENT_FPS: usize = 284;
}

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct FpsData {
    pub fps: f32,
    pub frame_time_ms: f32,
}

// ── Reader ────────────────────────────────────────────────────────────────────

pub struct RTSSReader {
    handle: isize,
    ptr: *mut std::ffi::c_void,
}

unsafe impl Send for RTSSReader {}
unsafe impl Sync for RTSSReader {}

impl RTSSReader {
    pub fn new() -> Self {
        Self { handle: 0, ptr: ptr::null_mut() }
    }

    fn connect(&mut self) -> bool {
        #[cfg(not(target_os = "windows"))]
        return false;

        #[cfg(target_os = "windows")]
        {
            let name: Vec<u16> = format!("{}\0", RTSS_SHM_NAME).encode_utf16().collect();
            let handle = unsafe { OpenFileMappingW(FILE_MAP_READ, 0, name.as_ptr()) };
            if handle == 0 {
                return false;
            }
            // windows-sys 0.52: MapViewOfFile returns MEMORY_MAPPED_VIEW_ADDRESS { Value: *mut c_void }
            let mapped = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0) };
            let ptr = mapped.Value;
            if ptr.is_null() {
                unsafe { CloseHandle(handle) };
                return false;
            }
            // Validate RTSS signature
            let sig = unsafe { ptr::read_unaligned(ptr as *const u32) };
            if sig != RTSS_SIGNATURE {
                unsafe { UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: ptr }); CloseHandle(handle) };
                return false;
            }
            self.handle = handle;
            self.ptr = ptr;
            true
        }
    }

    pub fn disconnect(&mut self) {
        #[cfg(target_os = "windows")]
        {
            if !self.ptr.is_null() {
                unsafe { UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: self.ptr }) };
                self.ptr = ptr::null_mut();
            }
            if self.handle != 0 {
                unsafe { CloseHandle(self.handle) };
                self.handle = 0;
            }
        }
    }

    /// Return FPS + frametime for the active game (the process with the highest
    /// current FPS in the RTSS entry array). Returns `None` if RTSS is not
    /// running or no game is being tracked.
    pub fn get_fps_data(&mut self) -> Option<FpsData> {
        if self.ptr.is_null() {
            if !self.connect() {
                return None;
            }
        }

        let base = self.ptr as *const u8;

        // Validate signature (RTSS may have restarted)
        let sig = unsafe { ptr::read_unaligned(base as *const u32) };
        if sig != RTSS_SIGNATURE {
            self.disconnect();
            return None;
        }

        let app_entry_size = unsafe { ptr::read_unaligned(base.add(RTSSHeader::OFF_APP_ENTRY_SIZE) as *const u32) } as usize;
        let app_arr_offset = unsafe { ptr::read_unaligned(base.add(RTSSHeader::OFF_APP_ARR_OFFSET) as *const u32) } as usize;
        let app_arr_size   = unsafe { ptr::read_unaligned(base.add(RTSSHeader::OFF_APP_ARR_SIZE)   as *const u32) } as usize;

        if app_entry_size == 0 {
            return None;
        }

        // Pick the slot with the highest active FPS (= foreground game)
        let mut best_fps: u32 = 0;
        let mut best_ftime: u32 = 0;

        for i in 0..app_arr_size {
            let entry = unsafe { base.add(app_arr_offset + i * app_entry_size) };

            let _pid = unsafe { ptr::read_unaligned(entry.add(RTSSEntry::OFF_PROCESS_ID) as *const u32) };

            let cur_fps = unsafe { ptr::read_unaligned(entry.add(RTSSEntry::OFF_CURRENT_FPS) as *const u32) };
            if cur_fps > best_fps {
                best_fps   = cur_fps;
                best_ftime = unsafe { ptr::read_unaligned(entry.add(RTSSEntry::OFF_FRAME_TIME) as *const u32) };
            }
        }

        if best_fps == 0 {
            return None; // no active game
        }

        Some(FpsData {
            fps: best_fps as f32 / 1000.0,
            frame_time_ms: best_ftime as f32 / 1000.0,
        })
    }
}

impl Drop for RTSSReader {
    fn drop(&mut self) {
        self.disconnect();
    }
}
