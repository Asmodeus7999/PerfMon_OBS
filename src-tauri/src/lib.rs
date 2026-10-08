// ─────────────────────────────────────────────────────────────────────────────
// lib.rs — Tauri application core
//
// Registers commands, sets up the background polling loop, and emits
// sensor data to the frontend via Tauri events every ~1 second.
// ─────────────────────────────────────────────────────────────────────────────

mod job;
mod lhm;
mod presentmon;
mod resize;
mod sysinfo;

use lhm::LhmReader;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use tauri::Emitter;

static CLICKTHROUGH_ACTIVE: AtomicBool = AtomicBool::new(false);
static BASE_WIDTH: AtomicU32 = AtomicU32::new(300);
static BASE_HEIGHT: AtomicU32 = AtomicU32::new(490);
/// Original window procedure, saved when the main window is subclassed (0 = none).
static PREV_PROC: AtomicIsize = AtomicIsize::new(0);

#[tauri::command]
fn set_clickthrough_active(active: bool) {
    CLICKTHROUGH_ACTIVE.store(active, Ordering::Relaxed);
}

#[tauri::command]
fn set_base_size(width: u32, height: u32) {
    BASE_WIDTH.store(width.max(1), Ordering::Relaxed);
    BASE_HEIGHT.store(height, Ordering::Relaxed);
}

// ── Payload types (JSON-serialised and sent to the frontend) ──────────────────

/// One sensor reading. Part of the payload emitted on the "sensor-update" event;
/// `srcId` is the numeric id the frontend (`src/modules/state.js`, `SRC`) looks sensors up by.
#[derive(Serialize, Clone, Debug)]
pub struct SensorEntry {
    pub name: String,
    pub units: String,
    pub value: Option<f32>,
    pub gpu: u32,
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

/// Full payload emitted on the "sensor-update" Tauri event every second.
#[derive(Serialize, Clone, Debug)]
struct SensorPayload {
    sensors: Vec<SensorEntry>,
    system_info: sysinfo::SystemInfo,
    fps: Option<presentmon::FpsData>,
}

// ── Tauri app entry point ─────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle().clone();

            // ── Background polling thread ─────────────────────────────────────
            // Runs independently of the async Tauri runtime.
            // Polls the LibreHardwareMonitor sidecar every second, attaches the latest
            // PresentMon FPS reading, and emits the result to the frontend.
            std::thread::spawn(move || {
                let mut lhm = LhmReader::new();
                let pm = presentmon::PresentMonReader::new();
                let mut sys_info_cache: Option<sysinfo::SystemInfo> = None;
                let mut error_count = 0;
                let max_errors = 5;

                loop {
                    match lhm.get_data() {
                        Some((sensors, gpu_infos)) => {
                            error_count = 0;
                            if sys_info_cache.is_none() && !gpu_infos.is_empty() {
                                sys_info_cache = sysinfo::build_system_info(&gpu_infos);
                            }

                            if let Some(ref sys_info) = sys_info_cache {
                                let fps = pm.as_ref().and_then(|p| p.get_fps_data());
                                let payload = SensorPayload {
                                    sensors,
                                    system_info: sys_info.clone(),
                                    fps,
                                };
                                let _ = app_handle.emit("sensor-update", &payload);
                            }
                        }
                        None => {
                            error_count += 1;
                            if error_count >= max_errors {
                                sys_info_cache = None;
                                let _ = app_handle.emit(
                                    "sensor-error",
                                    "No sensor data source found. Ensure PerfMon OBS is running as Administrator.",
                                );
                            }
                        }
                    }

                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
            });

            // ── Right-Alt bypass thread ───────────────────────────────────────
            // While Click-Through is enabled, holding Right-Alt unlocks mouse
            // interaction so you can click or drag the overlay without turning
            // click-through off permanently.
            let bypass_handle = app.handle().clone();
            std::thread::spawn(move || unsafe {
                use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_RMENU};
                let mut was_bypassed = false;

                loop {
                    if CLICKTHROUGH_ACTIVE.load(Ordering::Relaxed) {
                        let is_down = (GetAsyncKeyState(VK_RMENU as i32) as u16 & 0x8000) != 0;
                        if is_down != was_bypassed {
                            was_bypassed = is_down;
                            let _ = bypass_handle.emit("bypass-clickthrough", is_down);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(25));
                    } else {
                        if was_bypassed {
                            was_bypassed = false;
                            let _ = bypass_handle.emit("bypass-clickthrough", false);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(150));
                    }
                }
            });

            // ── Subclass main window to prevent side resizing & lock aspect ratio ────
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(main_win) = app.get_webview_window("main") {
                    if let Ok(hwnd) = main_win.hwnd() {
                        unsafe {
                            use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
                            use windows_sys::Win32::UI::WindowsAndMessaging::{
                                CallWindowProcW, GetWindowLongPtrW, SetWindowLongPtrW,
                                GWLP_WNDPROC, GWL_EXSTYLE,
                                HTBOTTOM, HTCLIENT, HTLEFT, HTRIGHT, HTTOP,
                                WNDPROC, WM_NCHITTEST, WS_EX_NOACTIVATE,
                            };

                            let raw_hwnd = hwnd.0 as HWND;

                            // Add WS_EX_NOACTIVATE so the overlay is fully invisible to the
                            // input chain & DWM compositor — fixes cursor coordinate mismatch
                            // in games that use raw input (e.g. osu!, CS2).
                            let ex_style = GetWindowLongPtrW(raw_hwnd, GWL_EXSTYLE);
                            SetWindowLongPtrW(
                                raw_hwnd,
                                GWL_EXSTYLE,
                                ex_style | WS_EX_NOACTIVATE as isize,
                            );

                            unsafe extern "system" fn corner_only_wndproc(
                                hwnd: HWND,
                                msg: u32,
                                wparam: WPARAM,
                                lparam: LPARAM,
                            ) -> LRESULT {
                                unsafe {
                                    const WM_SIZING: u32 = 0x0214;
                                    let prev: WNDPROC = std::mem::transmute(PREV_PROC.load(Ordering::Relaxed));

                                    // Block side resizing: turn side hits (left/right/top/bottom) into client hits
                                    if msg == WM_NCHITTEST {
                                        let hit = CallWindowProcW(prev, hwnd, msg, wparam, lparam);
                                        let is_side = [HTLEFT, HTRIGHT, HTTOP, HTBOTTOM]
                                            .iter()
                                            .any(|&h| hit == h as isize);
                                        return if is_side { HTCLIENT as isize } else { hit };
                                    }

                                    // Enforce the current aspect ratio while a corner is dragged
                                    if msg == WM_SIZING {
                                        let rect = &mut *(lparam as *mut RECT);
                                        let base_h = BASE_HEIGHT.load(Ordering::Relaxed).max(20) as f32;
                                        let base_w = BASE_WIDTH.load(Ordering::Relaxed).max(1) as f32;
                                        let (l, t, r, b) = resize::fit_aspect(
                                            wparam as u32,
                                            (rect.left, rect.top, rect.right, rect.bottom),
                                            base_h / base_w,
                                        );
                                        rect.left = l;
                                        rect.top = t;
                                        rect.right = r;
                                        rect.bottom = b;
                                        return 1;
                                    }

                                    CallWindowProcW(prev, hwnd, msg, wparam, lparam)
                                }
                            }

                            let prev = SetWindowLongPtrW(
                                raw_hwnd,
                                GWLP_WNDPROC,
                                corner_only_wndproc as *const () as isize,
                            );
                            PREV_PROC.store(prev, Ordering::Relaxed);
                        }
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|_window, event| {
            // When the main window is closed, exit immediately. Sidecars are tied to a Job
            // Object (job.rs), so Windows kills them when this process ends. NOTE:
            // std::process::exit() bypasses Rust's Drop, so the Drop impls in lhm.rs /
            // presentmon.rs do not run here.
            if let tauri::WindowEvent::Destroyed = event {
                // Fallback only if the job object could not be created: kill by image name
                // (this also kills any same-named process the user started themselves).
                #[cfg(target_os = "windows")]
                if !job::available() {
                    for proc in &["lhm-sidecar.exe", "PresentMon-x64.exe"] {
                        use std::os::windows::process::CommandExt;
                        let _ = std::process::Command::new("taskkill")
                            .args(&["/F", "/IM", proc])
                            .creation_flags(0x08000000) // CREATE_NO_WINDOW
                            .output();
                    }
                }
                std::process::exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![set_clickthrough_active, set_base_size])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}