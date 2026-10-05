use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct FpsData {
    pub fps: f32,
    pub frame_time_ms: f32,
}

pub struct PresentMonReader {
    child: Child,
    latest_data: Arc<Mutex<Option<FpsData>>>,
}

impl PresentMonReader {
    pub fn new() -> Option<Self> {
        let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
        let pm_path = exe_dir.join("PresentMon-x64.exe");

        if !pm_path.exists() {
            println!("[PresentMon] Executable not found at: {}", pm_path.display());
            return None;
        }

        println!("[PresentMon] Launching sidecar: {}", pm_path.display());

        let mut cmd = Command::new(pm_path);
        cmd.args(&["--output_stdout", "--stop_existing_session"])
           .stdout(Stdio::piped())
           .stderr(Stdio::piped())
           .stdin(Stdio::null());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                println!("[PresentMon] Failed to spawn: {}", e);
                return None;
            }
        };

        // Log stderr in a separate thread
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    if !line.is_empty() {
                        println!("[PresentMon-stderr] {}", line);
                    }
                }
            });
        }

        let stdout = child.stdout.take().expect("Failed to grab stdout");
        let latest_data = Arc::new(Mutex::new(None));
        let thread_data = latest_data.clone();

        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();

            // Read Header
            if reader.read_line(&mut line).is_err() || line.is_empty() {
                println!("[PresentMon] Failed to read CSV header.");
                return;
            }

            let headers: Vec<&str> = line.trim().split(',').collect();
            let app_idx = headers.iter().position(|&h| h == "Application");
            let ms_between_idx = headers.iter().position(|&h| h == "MsBetweenPresents");

            if app_idx.is_none() || ms_between_idx.is_none() {
                println!("[PresentMon] Failed to find required CSV columns in header.");
                return;
            }
            let app_idx = app_idx.unwrap();
            let ms_between_idx = ms_between_idx.unwrap();

            // Known system/desktop/launcher processes to always ignore
            let ignore_list: Vec<&str> = vec![
                "dwm.exe", "explorer.exe", "searchapp.exe", "searchhost.exe",
                "startmenuexperiencehost.exe", "shellexperiencehost.exe",
                "taskmgr.exe", "applicationframehost.exe", "systemsettings.exe",
                "windowsterminal.exe", "msedgewebview2.exe", "msedge.exe",
                "chrome.exe", "firefox.exe", "opera.exe", "brave.exe",
                "textinputhost.exe", "lockapp.exe", "perfmon-obs.exe",
                "video.ui.exe", "widgets.exe", "gamebar.exe",
                "gamebarpresencewriter.exe", "gamebarftserver.exe",
                // Game launcher helpers (not actual games)
                "hyphelper.exe", "launcher.exe", "crashhandler.exe",
                "epicgameslauncher.exe", "steamwebhelper.exe",
                "eadesktop.exe", "eabackgroundservice.exe",
                "ubisoftconnect.exe", "galaxyclient.exe",
                "riotclientservices.exe",
            ];

            // Track frame times per app in each measurement window
            use std::collections::HashMap;
            let mut app_frame_counts: HashMap<String, Vec<f32>> = HashMap::new();
            let mut last_update = Instant::now();
            let mut locked_app = String::new();       // Currently locked game
            let mut locked_since = Instant::now();     // When we last saw frames from locked app

            loop {
                line.clear();
                if reader.read_line(&mut line).is_err() || line.is_empty() {
                    println!("[PresentMon] stdout closed.");
                    break;
                }

                let cols: Vec<&str> = line.trim().split(',').collect();
                if cols.len() <= ms_between_idx {
                    continue;
                }

                let app_raw = cols[app_idx];
                let app = app_raw.to_lowercase();

                // Only collect frame data for non-system processes
                if !ignore_list.iter().any(|&p| app == p) && !app.contains("antigravity") {
                    if let Ok(dt) = cols[ms_between_idx].parse::<f32>() {
                        if dt > 0.0 && dt < 1000.0 {
                            let entry = app_frame_counts.entry(app.clone()).or_insert_with(Vec::new);
                            entry.push(dt);
                            if entry.len() > 120 {
                                entry.remove(0);
                            }
                        }
                    }
                }

                // Every 500ms, evaluate which app to report
                if last_update.elapsed() >= Duration::from_millis(500) {
                    // If we have a locked app, check if it's still producing frames
                    if !locked_app.is_empty() {
                        if let Some(times) = app_frame_counts.get(&locked_app) {
                            if times.len() >= 3 {
                                // Locked app is still active — report it
                                let avg_dt: f32 = times.iter().sum::<f32>() / times.len() as f32;
                                let fps = 1000.0 / avg_dt;
                                locked_since = Instant::now();

                                if let Ok(mut lock) = thread_data.lock() {
                                    *lock = Some(FpsData {
                                        fps: (fps * 10.0).round() / 10.0,
                                        frame_time_ms: (avg_dt * 100.0).round() / 100.0,
                                    });
                                }
                                app_frame_counts.clear();
                                last_update = Instant::now();
                                continue;
                            }
                        }

                        // Locked app stopped — wait 2 seconds before unlocking
                        if locked_since.elapsed() < Duration::from_secs(2) {
                            app_frame_counts.clear();
                            last_update = Instant::now();
                            continue;
                        }

                        // Unlock — the game has been idle for 2+ seconds
                        println!("[PresentMon] Unlocked: {}", locked_app);
                        locked_app.clear();
                        if let Ok(mut lock) = thread_data.lock() {
                            *lock = None;
                        }
                    }

                    // No locked app — find the best candidate
                    let mut best_app = String::new();
                    let mut best_fps: f32 = 0.0;
                    let mut best_frametime: f32 = 0.0;

                    for (name, times) in &app_frame_counts {
                        if times.len() < 3 {
                            continue;
                        }
                        let avg_dt: f32 = times.iter().sum::<f32>() / times.len() as f32;
                        let fps = 1000.0 / avg_dt;
                        if fps > best_fps {
                            best_fps = fps;
                            best_frametime = avg_dt;
                            best_app = name.clone();
                        }
                    }

                    if best_fps > 10.0 {
                        println!("[PresentMon] Locked: {} ({:.0} FPS)", best_app, best_fps);
                        locked_app = best_app;
                        locked_since = Instant::now();

                        if let Ok(mut lock) = thread_data.lock() {
                            *lock = Some(FpsData {
                                fps: (best_fps * 10.0).round() / 10.0,
                                frame_time_ms: (best_frametime * 100.0).round() / 100.0,
                            });
                        }
                    }

                    app_frame_counts.clear();
                    last_update = Instant::now();
                }
            }
        });

        Some(Self { child, latest_data })
    }

    pub fn get_fps_data(&self) -> Option<FpsData> {
        self.latest_data.lock().ok().and_then(|lock| lock.clone())
    }
}

impl Drop for PresentMonReader {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}
