// ─────────────────────────────────────────────────────────────────────────────
// afterburner.rs — MSI Afterburner MAHM shared-memory reader
//
// Ported from afterburner_server.py (Python ctypes / ctypes.Structure).
// The C structs use _pack_ = 1 in Python → Rust equivalent: #[repr(C, packed)].
//
// IMPORTANT: Rust does not allow taking references (&) to fields of a packed
// struct because they may be unaligned. All field reads use `ptr::read_unaligned`
// or a by-value copy via `{ packed.field }`.
// ─────────────────────────────────────────────────────────────────────────────

use std::ptr;
use serde::Serialize;

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::Memory::{MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ, MEMORY_MAPPED_VIEW_ADDRESS},
};

// ── MAHM constants ────────────────────────────────────────────────────────────
const MAHM_SIGNATURE: u32 = 0x4D41484D; // 'MAHM'
/// Sentinel value MSI Afterburner writes when a sensor value is unavailable
const FLT_MAX: f32 = 3.402_823_5e38_f32;
const FLT_MAX_THRESHOLD: f32 = FLT_MAX * 0.9;
const MAX_PATH: usize = 260;

// ── Afterburner data types (serialised and sent to frontend via Tauri event) ──

#[derive(Serialize, Clone, Debug)]
pub struct SensorEntry {
    pub name: String,
    pub units: String,
    pub value: Option<f32>,
    pub gpu: u32,
    /// Source-type ID constant from MAHMSharedMemory.h (matches the JS `SRC` map)
    #[serde(rename = "srcId")]
    pub src_id: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct GpuInfo {
    pub index: usize,
    pub device: String,
    pub family: String,
    pub vram_gb: Option<f32>,
}

// ── MAHM shared memory header (packed, matches MAHMSharedMemory.h) ────────────
// Field offsets (all u32 / i32 = 4 bytes, packed):
//   0  dwSignature      4
//   4  dwVersion        4
//   8  dwHeaderSize     4
//  12  dwNumEntries     4
//  16  dwEntrySize      4
//  20  time             4
//  24  dwNumGpuEntries  4
//  28  dwGpuEntrySize   4
struct MAHMHeader;
impl MAHMHeader {
    const OFF_SIGNATURE:       usize = 0;
    const OFF_HEADER_SIZE:     usize = 8;
    const OFF_NUM_ENTRIES:     usize = 12;
    const OFF_ENTRY_SIZE:      usize = 16;
    const OFF_NUM_GPU_ENTRIES: usize = 24;
    const OFF_GPU_ENTRY_SIZE:  usize = 28;
}

// ── MAHM sensor entry (packed, field offsets) ─────────────────────────────────
//   0    szSrcName           260
//   260  szSrcUnits          260
//   520  szLocalizedSrcName  260
//   780  szLocalizedSrcUnits 260
//  1040  szRecommendedFormat 260
//  1300  data                f32 (4)
//  1312  dwFlags             u32 (4)
//  1316  dwGpu               u32 (4)
//  1320  dwSrcId             u32 (4)
struct MAHMEntry;
#[allow(dead_code)]
impl MAHMEntry {
    const OFF_SRC_NAME:  usize = 0;
    const OFF_SRC_UNITS: usize = 260;
    const OFF_DATA:      usize = 1300;
    const OFF_FLAGS:     usize = 1312;
    const OFF_GPU:       usize = 1316;
    const OFF_SRC_ID:    usize = 1320;
    /// Total size of one entry as written by Afterburner (must match dwEntrySize)
    const SIZE: usize = 1324;
}

// ── GPU info entry offsets (same as Python raw-bytes approach) ────────────────
// Afterburner's GPU block layout:
//   0    szFamily  (MAX_PATH = 260 bytes)
//   260  szGpuId   (MAX_PATH = 260 bytes)
//   520  szDevice  (MAX_PATH = 260 bytes)
//   ...  (remaining fields we don't read)
struct MAHMGpuEntry;
impl MAHMGpuEntry {
    const OFF_FAMILY: usize = 0;
    const OFF_DEVICE: usize = MAX_PATH * 2; // 520
}

// ── Reader ────────────────────────────────────────────────────────────────────

pub struct AfterburnerReader {
    handle: isize,
    ptr: *mut std::ffi::c_void,
    was_connected: bool,
    sig_error_shown: bool,
}

// Safety: The raw pointer is pinned to the lifetime of this reader and only
// ever accessed from the single background polling thread.
unsafe impl Send for AfterburnerReader {}
unsafe impl Sync for AfterburnerReader {}

impl AfterburnerReader {
    pub fn new() -> Self {
        Self {
            handle: 0,
            ptr: ptr::null_mut(),
            was_connected: false,
            sig_error_shown: false,
        }
    }

    fn connect(&mut self) -> bool {
        #[cfg(not(target_os = "windows"))]
        return false;

        #[cfg(target_os = "windows")]
        {
            let name: Vec<u16> = "MAHMSharedMemory\0".encode_utf16().collect();
            let handle = unsafe { OpenFileMappingW(FILE_MAP_READ, 0, name.as_ptr()) };
            if handle == 0 {
                if self.was_connected {
                    eprintln!("[Afterburner] Shared memory lost. Is MSI Afterburner still running?");
                    self.was_connected = false;
                }
                return false;
            }

            // windows-sys 0.52: MapViewOfFile returns MEMORY_MAPPED_VIEW_ADDRESS { Value: *mut c_void }
            let mapped = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0) };
            let ptr = mapped.Value;
            if ptr.is_null() {
                eprintln!("[Afterburner] MapViewOfFile failed");
                unsafe { CloseHandle(handle) };
                return false;
            }

            // Validate the MAHM signature
            let sig = unsafe { ptr::read_unaligned(ptr as *const u32) };
            if sig != MAHM_SIGNATURE {
                if !self.sig_error_shown {
                    eprintln!(
                        "[Afterburner] Invalid MAHM signature: {:#010x} (expected {:#010x}). Waiting for Afterburner to initialise...",
                        sig, MAHM_SIGNATURE
                    );
                    self.sig_error_shown = true;
                }
                unsafe { UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: ptr }); CloseHandle(handle) };
                return false;
            }
            self.sig_error_shown = false;

            let base = ptr as *const u8;
            let version = unsafe { ptr::read_unaligned(base.add(4) as *const u32) };
            println!(
                "[Afterburner] Connected to shared memory v{}.{}",
                version >> 16,
                version & 0xFFFF
            );
            self.handle = handle;
            self.ptr = ptr;
            self.was_connected = true;
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

    fn is_valid(value: f32) -> bool {
        value < FLT_MAX_THRESHOLD && !value.is_nan() && !value.is_infinite()
    }

    /// Read all sensor entries and GPU info from the MAHM shared memory block.
    /// Returns `None` if Afterburner is not running or the memory block is invalid.
    pub fn get_data(&mut self) -> Option<(Vec<SensorEntry>, Vec<GpuInfo>)> {
        if self.ptr.is_null() {
            if !self.connect() {
                return None;
            }
        }

        let base = self.ptr as *const u8;

        // Read header fields via unaligned reads (safe even from packed layout)
        let signature      = unsafe { ptr::read_unaligned(base.add(MAHMHeader::OFF_SIGNATURE)      as *const u32) };
        let header_size    = unsafe { ptr::read_unaligned(base.add(MAHMHeader::OFF_HEADER_SIZE)    as *const u32) } as usize;
        let num_entries    = unsafe { ptr::read_unaligned(base.add(MAHMHeader::OFF_NUM_ENTRIES)    as *const u32) } as usize;
        let entry_size     = unsafe { ptr::read_unaligned(base.add(MAHMHeader::OFF_ENTRY_SIZE)     as *const u32) } as usize;
        let num_gpu_entries= unsafe { ptr::read_unaligned(base.add(MAHMHeader::OFF_NUM_GPU_ENTRIES)as *const u32) } as usize;
        let gpu_entry_size = unsafe { ptr::read_unaligned(base.add(MAHMHeader::OFF_GPU_ENTRY_SIZE) as *const u32) } as usize;

        if signature != MAHM_SIGNATURE {
            self.disconnect();
            return None;
        }

        // ── Sensor entries ───────────────────────────────────────────────────
        let sensors_base = header_size;
        let mut entries = Vec::with_capacity(num_entries);

        for i in 0..num_entries {
            let entry_offset = sensors_base + i * entry_size;
            let e = unsafe { base.add(entry_offset) };

            let name  = unsafe { read_cstr(e, MAHMEntry::OFF_SRC_NAME,  MAX_PATH) };
            let units = unsafe { read_cstr(e, MAHMEntry::OFF_SRC_UNITS, MAX_PATH) };
            let data  = unsafe { ptr::read_unaligned(e.add(MAHMEntry::OFF_DATA) as *const f32) };
            let gpu   = unsafe { ptr::read_unaligned(e.add(MAHMEntry::OFF_GPU)  as *const u32) };
            let src_id= unsafe { ptr::read_unaligned(e.add(MAHMEntry::OFF_SRC_ID)as *const u32)};

            let value = if Self::is_valid(data) {
                // Round to 2 decimal places (matching the Python round(float, 2))
                Some(((data * 100.0).round()) / 100.0)
            } else {
                None
            };

            entries.push(SensorEntry { name, units, value, gpu, src_id });
        }

        // ── GPU info entries (v2.0+) ─────────────────────────────────────────
        let gpu_base = sensors_base + num_entries * entry_size;
        let mut gpu_infos = Vec::with_capacity(num_gpu_entries);

        if num_gpu_entries > 0 && gpu_entry_size > 0 {
            for i in 0..num_gpu_entries {
                let g = unsafe { base.add(gpu_base + i * gpu_entry_size) };

                let device = unsafe { read_cstr(g, MAHMGpuEntry::OFF_DEVICE, MAX_PATH) };
                let family = unsafe { read_cstr(g, MAHMGpuEntry::OFF_FAMILY, MAX_PATH) };

                // VRAM from Windows display adapter registry (avoids AMD zero bug)
                let vram_gb = crate::sysinfo::get_dedicated_vram_gb(i);

                gpu_infos.push(GpuInfo { index: i, device, family, vram_gb });
            }
        }

        Some((entries, gpu_infos))
    }
}

impl Drop for AfterburnerReader {
    fn drop(&mut self) {
        self.disconnect();
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Read a null-terminated ASCII/UTF-8 string from a raw byte pointer at `offset`
/// with at most `max_len` bytes examined.
///
/// # Safety
/// Caller must ensure `ptr + offset + max_len` is within a valid mapped region.
unsafe fn read_cstr(ptr: *const u8, offset: usize, max_len: usize) -> String {
    let slice = std::slice::from_raw_parts(ptr.add(offset), max_len);
    let end = slice.iter().position(|&b| b == 0).unwrap_or(max_len);
    String::from_utf8_lossy(&slice[..end]).trim().to_string()
}
