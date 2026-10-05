// ─────────────────────────────────────────────────────────────────────────────
// lhm.rs — LibreHardwareMonitor data reader (dual-mode)
//
// Supports two modes for reading hardware sensor data:
//
//   1. **Sidecar mode** (preferred): Reads JSON lines from the bundled
//      lhm-sidecar.exe process via stdout. This is the zero-config path —
//      no separate LHM installation needed.
//
//   2. **Web server mode** (fallback): Connects to LHM's built-in HTTP
//      JSON endpoint at http://localhost:8085/data.json. Used when the
//      sidecar is unavailable or the user prefers running LHM standalone.
//
// Both modes produce the same LhmNode tree, so the downstream sensor
// mapping logic is shared.
// ─────────────────────────────────────────────────────────────────────────────

use serde::Deserialize;
use std::collections::HashMap;
use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;

use crate::{SensorEntry, GpuInfo};

#[derive(Deserialize, Debug, Clone)]
pub struct LhmNode {
    #[serde(rename = "Text")]
    pub text: String,
    #[serde(rename = "Value")]
    pub value: String,
    #[serde(rename = "Type")]
    pub type_name: Option<String>,
    #[serde(rename = "HardwareId")]
    pub hardware_id: Option<String>,
    #[serde(default)]
    #[serde(rename = "Children")]
    pub children: Vec<LhmNode>,
}

// ── Sidecar data source ──────────────────────────────────────────────────────

/// Manages the lhm-sidecar.exe child process and reads JSON lines from stdout.
struct SidecarSource {
    _child: Child,
    rx: mpsc::Receiver<String>,
    latest_line: Option<String>,
}

impl SidecarSource {
    fn spawn() -> Option<Self> {
        // Locate the sidecar binary next to our own executable
        let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
        let sidecar_path = exe_dir.join("lhm-sidecar.exe");

        if !sidecar_path.exists() {
            println!("[LHM] Sidecar not found at: {}", sidecar_path.display());
            return None;
        }

        println!("[LHM] Launching sidecar: {}", sidecar_path.display());

        #[cfg(target_os = "windows")]
        let child = {
            use std::os::windows::process::CommandExt;
            Command::new(&sidecar_path)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null())
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .spawn()
        };

        #[cfg(not(target_os = "windows"))]
        let child = Command::new(&sidecar_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn();

        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                println!("[LHM] Failed to spawn sidecar: {}", e);
                return None;
            }
        };

        let stdout = child.stdout.take()?;
        let stderr = child.stderr.take();

        // Channel for passing JSON lines from the reader thread
        let (tx, rx) = mpsc::channel::<String>();

        // Stdout reader thread — reads JSON lines and sends them via channel
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) if !l.trim().is_empty() => {
                        if tx.send(l).is_err() {
                            break; // receiver dropped
                        }
                    }
                    Err(_) => break,
                    _ => {}
                }
            }
        });

        // Stderr reader thread — forwards sidecar logs to our console
        if let Some(stderr) = stderr {
            std::thread::spawn(move || {
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(l) => println!("{}", l),
                        Err(_) => break,
                    }
                }
            });
        }

        Some(Self {
            _child: child,
            rx,
            latest_line: None,
        })
    }

    /// Drain the channel and keep only the most recent JSON line.
    fn poll(&mut self) -> Option<&str> {
        // Drain all available messages, keeping only the latest
        while let Ok(line) = self.rx.try_recv() {
            self.latest_line = Some(line);
        }
        self.latest_line.as_deref()
    }
}

impl Drop for SidecarSource {
    fn drop(&mut self) {
        let _ = self._child.kill();
    }
}

// ── Web server data source (existing fallback) ──────────────────────────────

fn fetch_from_web_server() -> Option<LhmNode> {
    let res = ureq::get("http://localhost:8085/data.json")
        .timeout(std::time::Duration::from_millis(2000))
        .call()
        .ok()?;
    res.into_json().ok()
}

// ── Public reader ────────────────────────────────────────────────────────────

pub struct LhmReader {
    sidecar: Option<SidecarSource>,
    sidecar_attempted: bool,
}

unsafe impl Send for LhmReader {}
unsafe impl Sync for LhmReader {}

impl LhmReader {
    pub fn new() -> Self {
        Self {
            sidecar: None,
            sidecar_attempted: false,
        }
    }

    pub fn get_data(&mut self) -> Option<(Vec<SensorEntry>, Vec<GpuInfo>)> {
        // Try sidecar first
        if let Some(root) = self.try_sidecar() {
            return Self::parse_tree(root);
        }

        // Fall back to web server
        if let Some(root) = fetch_from_web_server() {
            return Self::parse_tree(root);
        }

        None
    }

    fn try_sidecar(&mut self) -> Option<LhmNode> {
        // Attempt to spawn the sidecar once
        if self.sidecar.is_none() && !self.sidecar_attempted {
            self.sidecar_attempted = true;
            self.sidecar = SidecarSource::spawn();
        }

        let sidecar = self.sidecar.as_mut()?;
        let line = sidecar.poll()?;

        serde_json::from_str::<LhmNode>(line).ok()
    }

    // ── Shared tree → sensor mapping (unchanged from original) ───────────────

    fn parse_tree(root: LhmNode) -> Option<(Vec<SensorEntry>, Vec<GpuInfo>)> {
        let mut entries = Vec::new();
        let mut gpus = HashMap::new();

        // Recursively search the JSON tree for Sensors
        // Queue holds: (Node, Current Hardware ID, Current Hardware Name)
        let mut queue = Vec::new();
        for child in &root.children {
            queue.push((child, child.hardware_id.clone(), child.text.clone()));
        }

        let mut cpu_clock_values: Vec<f32> = Vec::new();

        while let Some((node, mut hw_id, mut hw_name)) = queue.pop() {
            // If this node represents hardware, update the tracked hw_id
            if node.hardware_id.is_some() {
                hw_id = node.hardware_id.clone();
                hw_name = node.text.clone();
            }

            // Check if this node is a Sensor (has a Type) and has a known hardware parent
            if let (Some(ref t), Some(ref hid)) = (&node.type_name, &hw_id) {
                let lower_hid = hid.to_lowercase();
                let lower_name = node.text.to_lowercase();
                
                let is_gpu = lower_hid.contains("gpu");
                let is_cpu = lower_hid.contains("cpu");
                let is_ram = lower_hid.contains("ram") || lower_hid.contains("vram");

                let mut gpu_idx = 0xFFFFFFFF;
                if is_gpu {
                    // Extract GPU index from /gpu-amd/0
                    if let Some(idx_str) = hid.split('/').last() {
                        if let Ok(idx) = idx_str.parse::<u32>() {
                            gpu_idx = idx;
                            gpus.entry(idx).or_insert_with(|| GpuInfo {
                                index: idx as usize,
                                device: hw_name.clone(),
                                family: "Unknown".to_string(),
                                vram_gb: crate::sysinfo::get_dedicated_vram_gb(idx as usize),
                            });
                        }
                    }
                }

                // Map LHM node to Afterburner SRC ID
                let src_id = if is_gpu {
                    match t.as_str() {
                        "Temperature" if lower_name.contains("core") => Some(0x00),
                        "Clock"       if lower_name.contains("core") => Some(0x20),
                        "Load"        if lower_name.contains("core") => Some(0x30),
                        "SmallData"   if lower_name == "gpu memory used" => Some(0x31),
                        "Power"       if lower_name.contains("package") || lower_name.contains("gpu power") || lower_name.contains("total") => Some(0x61),
                        _ => None
                    }
                } else if is_cpu {
                    match t.as_str() {
                        "Temperature" if lower_name.contains("package") || lower_name.contains("core average") => Some(0x80),
                        "Load"        if lower_name.contains("total") => Some(0x90),
                        "Power"       if lower_name.contains("package") => Some(0x100),
                        "Clock"       if lower_name.contains("core #") => {
                            // Collect all core clocks for averaging later
                            if let Some(val) = node.value.replace(',', ".").split_whitespace().next().and_then(|s| s.parse::<f32>().ok()) {
                                cpu_clock_values.push(val);
                            }
                            None // Don't emit individual cores
                        },
                        _ => None
                    }
                } else if is_ram && !lower_hid.contains("vram") {
                    match t.as_str() {
                        "Data" if lower_name == "used memory" || lower_name == "memory used" || lower_name == "memory" => Some(0x91),
                        _ => None
                    }
                } else {
                    None
                };

                if let Some(id) = src_id {
                    let units = match t.as_str() {
                        "Temperature" => "°C",
                        "Load" => "%",
                        "Clock" => "MHz",
                        "Power" => "W",
                        "Data" => "GB",
                        "SmallData" => "MB",
                        _ => ""
                    }.to_string();

                    // Parse the numeric part of the Value string (e.g. "45.0 °C" -> 45.0)
                    let parsed_val = node.value
                        .replace(',', ".") 
                        .split_whitespace()
                        .next()
                        .and_then(|s| s.parse::<f32>().ok());

                    if let Some(mut final_value) = parsed_val {
                        let mut final_units = units;

                        if id == 0x91 && t == "Data" {
                            // LHM web server outputs RAM in GB, Afterburner uses MB.
                            final_value *= 1024.0;
                            final_units = "MB".to_string();
                        }

                        entries.push(SensorEntry {
                            name: node.text.clone(),
                            units: final_units,
                            value: Some((final_value * 100.0).round() / 100.0),
                            gpu: gpu_idx,
                            src_id: id,
                        });
                    }
                }
            }

            // Queue children for processing
            for child in &node.children {
                queue.push((child, hw_id.clone(), hw_name.clone()));
            }
        }

        // Average all CPU core clocks and emit a single entry
        if !cpu_clock_values.is_empty() {
            let avg = cpu_clock_values.iter().sum::<f32>() / cpu_clock_values.len() as f32;
            entries.push(SensorEntry {
                name: "CPU Clock (avg)".to_string(),
                units: "MHz".to_string(),
                value: Some((avg * 100.0).round() / 100.0),
                gpu: 0xFFFFFFFF,
                src_id: 0xA0,
            });
        }

        let mut gpu_infos: Vec<GpuInfo> = gpus.into_values().collect();
        gpu_infos.sort_by_key(|g| g.index);

        Some((entries, gpu_infos))
    }
}
