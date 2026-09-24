// ─────────────────────────────────────────────────────────────────────────────
// lib.rs — Tauri application core
//
// Registers commands, sets up the background polling loop, and emits
// sensor data to the frontend via Tauri events every ~1 second.
// ─────────────────────────────────────────────────────────────────────────────

mod afterburner;
mod rtss;
mod sysinfo;

use afterburner::AfterburnerReader;
use rtss::RTSSReader;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::Emitter;

static CLICKTHROUGH_ACTIVE: AtomicBool = AtomicBool::new(false);
static BASE_WIDTH: AtomicU32 = AtomicU32::new(300);
static BASE_HEIGHT: AtomicU32 = AtomicU32::new(490);

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

/// Full data payload emitted on the "sensor-update" Tauri event every second.
/// Matches the JSON structure that the existing overlay/script.js already parses
/// (`payload.sensors`, `payload.system_info`) so the frontend code barely changes.
#[derive(Serialize, Clone, Debug)]
struct SensorPayload {
    sensors: Vec<afterburner::SensorEntry>,
    system_info: sysinfo::SystemInfo,
    fps: Option<rtss::FpsData>,
}

// ── Tauri app entry point ─────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle().clone();

            // ── Background polling thread ─────────────────────────────────────
            // Runs independently of the async Tauri runtime.
            // Polls shared memory every 1 second and emits events to the frontend.
            std::thread::spawn(move || {
                let mut ab = AfterburnerReader::new();
                let mut rtss = RTSSReader::new();
                // Cache system info (CPU name, RAM, GPU names) so we don't re-read
                // expensive OS APIs every second.  Mirrors `_system_info_cache` in Python.
                let mut sys_info_cache: Option<sysinfo::SystemInfo> = None;

                loop {
                    match ab.get_data() {
                        Some((sensors, gpu_infos)) => {
                            // Rebuild cache if empty (e.g. after Afterburner restart)
                            if sys_info_cache.is_none() {
                                sys_info_cache = sysinfo::build_system_info(&gpu_infos);
                            }

                            if let Some(ref sys_info) = sys_info_cache {
                                let fps = rtss.get_fps_data();
                                let payload = SensorPayload {
                                    sensors,
                                    system_info: sys_info.clone(),
                                    fps,
                                };
                                let _ = app_handle.emit("sensor-update", &payload);
                            }
                        }
                        None => {
                            // Afterburner not running — reset cache so names are
                            // re-read fresh when it starts again
                            sys_info_cache = None;
                            let _ = app_handle.emit(
                                "sensor-error",
                                "MSI Afterburner not found. Is it running?",
                            );
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
                                CallWindowProcW, SetWindowLongPtrW, GWLP_WNDPROC,
                                HTBOTTOM, HTCLIENT, HTLEFT, HTRIGHT, HTTOP,
                                WNDPROC, WM_NCHITTEST,
                            };

                            static mut PREV_PROC: WNDPROC = None;

                            unsafe extern "system" fn corner_only_wndproc(
                                hwnd: HWND,
                                msg: u32,
                                wparam: WPARAM,
                                lparam: LPARAM,
                            ) -> LRESULT {
                                // Block side resizing: convert HTLEFT, HTRIGHT, HTTOP, HTBOTTOM to HTCLIENT
                                if msg == WM_NCHITTEST {
                                    let hit = CallWindowProcW(PREV_PROC, hwnd, msg, wparam, lparam);
                                    if hit == HTLEFT as isize
                                        || hit == HTRIGHT as isize
                                        || hit == HTTOP as isize
                                        || hit == HTBOTTOM as isize
                                    {
                                        return HTCLIENT as isize;
                                    }
                                    return hit;
                                }

                                // Enforce dynamic aspect ratio during corner resizing
                                if msg == 0x0214 { // WM_SIZING
                                    let rect = lparam as *mut RECT;
                                    let width = (*rect).right - (*rect).left;
                                    let height = (*rect).bottom - (*rect).top;
                                    let base_h = BASE_HEIGHT.load(Ordering::Relaxed).max(20) as f32;
                                    let base_w = BASE_WIDTH.load(Ordering::Relaxed).max(1) as f32;
                                    let ratio: f32 = base_h / base_w;

                                    match wparam as u32 {
                                        8 => { // WMSZ_BOTTOMRIGHT
                                            if (height as f32 / width as f32) > ratio {
                                                (*rect).right = (*rect).left + (height as f32 / ratio).round() as i32;
                                            } else {
                                                (*rect).bottom = (*rect).top + (width as f32 * ratio).round() as i32;
                                            }
                                        }
                                        7 => { // WMSZ_BOTTOMLEFT
                                            if (height as f32 / width as f32) > ratio {
                                                (*rect).left = (*rect).right - (height as f32 / ratio).round() as i32;
                                            } else {
                                                (*rect).bottom = (*rect).top + (width as f32 * ratio).round() as i32;
                                            }
                                        }
                                        5 => { // WMSZ_TOPRIGHT
                                            if (height as f32 / width as f32) > ratio {
                                                (*rect).right = (*rect).left + (height as f32 / ratio).round() as i32;
                                            } else {
                                                (*rect).top = (*rect).bottom - (width as f32 * ratio).round() as i32;
                                            }
                                        }
                                        4 => { // WMSZ_TOPLEFT
                                            if (height as f32 / width as f32) > ratio {
                                                (*rect).left = (*rect).right - (height as f32 / ratio).round() as i32;
                                            } else {
                                                (*rect).top = (*rect).bottom - (width as f32 * ratio).round() as i32;
                                            }
                                        }
                                        _ => {}
                                    }
                                    return 1;
                                }

                                CallWindowProcW(PREV_PROC, hwnd, msg, wparam, lparam)
                            }

                            let raw_hwnd = hwnd.0 as HWND;
                            let prev = SetWindowLongPtrW(
                                raw_hwnd,
                                GWLP_WNDPROC,
                                corner_only_wndproc as *const () as isize,
                            );
                            PREV_PROC = std::mem::transmute(prev);
                        }
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_clickthrough_active, set_base_size])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}