// ─────────────────────────────────────────────────────────────────────────────
// lhm.rs — LibreHardwareMonitor Web Server reader
//
// Replaces WMI querying with HTTP JSON parsing from the Local Web Server
// built into LibreHardwareMonitor (Options > Remote Web Server).
// This fixes known issues where LHM's WMI broadcaster crashes on modern PCs.
// ─────────────────────────────────────────────────────────────────────────────

use serde::Deserialize;
use std::collections::HashMap;

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

pub struct LhmReader {}

unsafe impl Send for LhmReader {}
unsafe impl Sync for LhmReader {}

impl LhmReader {
    pub fn new() -> Self {
        Self {}
    }

    pub fn get_data(&mut self) -> Option<(Vec<SensorEntry>, Vec<GpuInfo>)> {
        // Fetch JSON from LHM local web server
        let res = match ureq::get("http://localhost:8085/data.json")
            .timeout(std::time::Duration::from_millis(800))
            .call()
        {
            Ok(r) => r,
            Err(_) => return None,
        };

        let root: LhmNode = match res.into_json() {
            Ok(json) => json,
            Err(_) => return None,
        };

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
                        "Load"        if lower_name.contains("memory") => Some(0x91),
                        "Data"        if lower_name == "used memory" || lower_name == "memory used" => Some(0x91),
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
