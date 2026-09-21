// Tauri v2 convention: main.rs is a thin launcher.
// All logic and Tauri builder setup lives in lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    std::env::set_var(
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "--disable-gpu --disable-gpu-compositing --disable-d3d11"
);
    perfmon_obs_lib::run();
}
