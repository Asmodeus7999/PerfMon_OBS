// Tauri v2 convention: main.rs is a thin launcher.
// All logic and Tauri builder setup lives in lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // SAFETY: this runs first in main(), before any threads are spawned
    // (Tauri and the sidecar readers start later in run()), so nothing else
    // can be reading the environment concurrently.
    unsafe {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE --use-angle=d3d11 --force-device-scale-factor=1",
        );
    }
    perfmon_obs_lib::run();
}
