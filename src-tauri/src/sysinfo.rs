// ─────────────────────────────────────────────────────────────────────────────
// sysinfo.rs — Windows system information helpers
//
// Ported from the Python helper functions in afterburner_server.py:
//   _get_cpu_name()            → get_cpu_name()
//   _get_total_ram_gb()        → get_total_ram_gb()
//   _get_dedicated_vram_gb()   → get_dedicated_vram_gb()   (called by afterburner.rs)
//
// RAM-type detection is omitted — it was only used in a console log, not shown
// in the UI. Can be added later via the `wmi` crate if needed.
// ─────────────────────────────────────────────────────────────────────────────

use serde::Serialize;
use winreg::{enums::*, RegKey};

#[cfg(target_os = "windows")]
use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

// ── Public data types ─────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct SystemInfo {
    pub cpu_name: String,
    pub ram_gb: u32,
    pub ram_type: String,
    pub gpus: Vec<crate::afterburner::GpuInfo>,
}

// ── System info builder ───────────────────────────────────────────────────────

/// Assemble static hardware info from Windows APIs + Afterburner GPU entries.
///
/// Returns `None` until all GPUs have a valid VRAM reading so the frontend
/// always shows complete data (mirrors the Python caching logic).
pub fn build_system_info(gpu_infos: &[crate::afterburner::GpuInfo]) -> Option<SystemInfo> {
    // Don't cache yet if any GPU still has no VRAM reading
    if gpu_infos.iter().any(|g| g.vram_gb.is_none()) {
        return None;
    }

    let cpu_name = get_cpu_name();
    let ram_gb   = get_total_ram_gb();

    println!("[SystemInfo] CPU: {}  |  RAM: {} GB", cpu_name, ram_gb);
    for g in gpu_infos {
        println!(
            "[SystemInfo] GPU[{}]: {}  |  VRAM: {} GB",
            g.index,
            g.device,
            g.vram_gb.map(|v| format!("{:.1}", v)).unwrap_or_else(|| "?".into())
        );
    }

    Some(SystemInfo {
        cpu_name,
        ram_gb,
        ram_type: String::new(), // not shown in UI; expand via wmi crate if desired
        gpus: gpu_infos.to_vec(),
    })
}

// ── CPU name ─────────────────────────────────────────────────────────────────

/// Read the CPU brand string from the Windows registry and clean it up.
/// Example: "Intel(R) Core(TM) i9-13900K CPU @ 3.00GHz" → "Intel Core i9-13900K"
pub fn get_cpu_name() -> String {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(key) = hklm.open_subkey(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") {
        if let Ok(name) = key.get_value::<String, _>("ProcessorNameString") {
            return clean_cpu_name(name);
        }
    }
    "CPU".to_string()
}

fn clean_cpu_name(name: String) -> String {
    let name = name
        .replace("(R)", "")
        .replace("(r)", "")
        .replace("(TM)", "")
        .replace("(tm)", "")
        .replace("CPU", "");

    // Strip trailing "@ X.XXGHz" clock speed annotation
    let name = if let Some(at_pos) = name.find('@') {
        name[..at_pos].to_string()
    } else {
        name
    };

    // Collapse extra whitespace
    name.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ── Total RAM ─────────────────────────────────────────────────────────────────

/// Return total physical RAM in whole GB (rounded) via GlobalMemoryStatusEx.
pub fn get_total_ram_gb() -> u32 {
    #[cfg(not(target_os = "windows"))]
    return 0;

    #[cfg(target_os = "windows")]
    {
        let mut stat = MEMORYSTATUSEX {
            dwLength:                std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            dwMemoryLoad:            0,
            ullTotalPhys:            0,
            ullAvailPhys:            0,
            ullTotalPageFile:        0,
            ullAvailPageFile:        0,
            ullTotalVirtual:         0,
            ullAvailVirtual:         0,
            ullAvailExtendedVirtual: 0,
        };
        unsafe { GlobalMemoryStatusEx(&mut stat) };
        (stat.ullTotalPhys as f64 / (1024_f64.powi(3))).round() as u32
    }
}

// ── Dedicated VRAM (called from afterburner.rs while building GpuInfo) ───────

/// Read dedicated VRAM in GB from the Windows display adapter registry key.
///
/// Registry path:
///   HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-...}\000x
///   HardwareInformation.MemorySize  (REG_BINARY, 8-byte little-endian QWORD)
///
/// This is more reliable than WMI AdapterRAM (uint32 overflow on >4 GB cards)
/// or MAHM dwMemAmount (zero on AMD). Mirrors `_get_dedicated_vram_gb()` in Python.
pub fn get_dedicated_vram_gb(adapter_index: usize) -> Option<f32> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let path = format!(
        r"SYSTEM\CurrentControlSet\Control\Class\{{4d36e968-e325-11ce-bfc1-08002be10318}}\{:04}",
        adapter_index
    );
    let key = hklm.open_subkey(&path).ok()?;
    let raw_val = key.get_raw_value("HardwareInformation.MemorySize").ok()?;
    let raw = &raw_val.bytes;

    let mem_bytes: u64 = if raw.len() >= 8 {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&raw[..8]);
        u64::from_le_bytes(buf)
    } else if raw.len() == 4 {
        let mut buf = [0u8; 4];
        buf.copy_from_slice(&raw[..4]);
        u32::from_le_bytes(buf) as u64
    } else {
        return None;
    };

    if mem_bytes == 0 {
        return None;
    }

    // Round to 1 decimal place (e.g. 8.0 GB, 16.0 GB)
    let gb = mem_bytes as f64 / (1024_f64.powi(3));
    Some(((gb * 10.0).round() / 10.0) as f32)
}
