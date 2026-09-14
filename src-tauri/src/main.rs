// Tauri v2 convention: main.rs is a thin launcher.
// All logic and Tauri builder setup lives in lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    perfmon_obs_lib::run();
}
