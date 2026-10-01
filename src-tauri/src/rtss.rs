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

const RTSS_SIGNATURE: u32 = 0x52545353; // 'RTSS' in memory order
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
    const OFF_PROCESS_ID: usize = 0;
    const OFF_TIME0:      usize = 268;
    const OFF_TIME1:      usize = 272;
    const OFF_FRAMES:     usize = 276;
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

        // Pick the slot with the highest calculated FPS (= foreground game)
        let mut best_fps: f32 = 0.0;
        let mut best_ftime: f32 = 0.0;

        for i in 0..app_arr_size {
            let entry = unsafe { base.add(app_arr_offset + i * app_entry_size) };

            let pid = unsafe { ptr::read_unaligned(entry.add(RTSSEntry::OFF_PROCESS_ID) as *const u32) };
            if pid == 0 {
                continue; // empty slot
            }

            let time0  = unsafe { ptr::read_unaligned(entry.add(RTSSEntry::OFF_TIME0)  as *const u32) };
            let time1  = unsafe { ptr::read_unaligned(entry.add(RTSSEntry::OFF_TIME1)  as *const u32) };
            let frames = unsafe { ptr::read_unaligned(entry.add(RTSSEntry::OFF_FRAMES) as *const u32) };

            let dt = time1.wrapping_sub(time0);
            if dt == 0 || frames == 0 || time0 == 0 {
                continue;
            }

            // FPS = frames * 1000 / (time1 - time0)   [times are in ms]
            let fps = frames as f32 * 1000.0 / dt as f32;
            // Frametime = (time1 - time0) / frames     [result in ms]
            let ftime = dt as f32 / frames as f32;

            if fps > best_fps {
                best_fps = fps;
                best_ftime = ftime;
            }
        }

        if best_fps < 0.1 {
            return None; // no active game
        }

        Some(FpsData {
            fps: (best_fps * 10.0).round() / 10.0,
            frame_time_ms: (best_ftime * 100.0).round() / 100.0,
        })
    }
}

impl Drop for RTSSReader {
    fn drop(&mut self) {
        self.disconnect();
    }
}
