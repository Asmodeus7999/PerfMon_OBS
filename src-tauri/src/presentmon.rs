use std::collections::HashMap;
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

/// One swap chain of one process. Keying on the pair (not the exe name) keeps
/// frames from different swap chains of the same process from being averaged together.
#[derive(Hash, Eq, PartialEq, Clone, Debug)]
struct Key {
    pid: u32,
    swap: String,
}

/// PID of the foreground window. Falls back to `last` when there is no foreground
/// window or it belongs to this app (e.g. the overlay was clicked), so interacting
/// with the overlay never costs us the game.
#[cfg(target_os = "windows")]
fn foreground_pid(last: &mut u32) -> u32 {
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == 0 {
            return *last;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 || pid == GetCurrentProcessId() {
            return *last;
        }
        *last = pid;
        pid
    }
}

#[cfg(not(target_os = "windows"))]
fn foreground_pid(last: &mut u32) -> u32 {
    *last
}

fn publish(data: &Arc<Mutex<Option<FpsData>>>, fps: f32, avg_dt: f32) {
    if let Ok(mut lock) = data.lock() {
        *lock = Some(FpsData {
            fps: (fps * 10.0).round() / 10.0,
            frame_time_ms: (avg_dt * 100.0).round() / 100.0,
        });
    }
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
            // Optional: without ProcessID the foreground bonus simply never applies.
            let pid_idx = headers.iter().position(|&h| h == "ProcessID");
            let swap_idx = headers.iter().position(|&h| h == "SwapChainAddress");
            let debug = std::env::var("PERFMON_PM_DEBUG").is_ok();

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
                "riotclientservices.exe", "obs64.exe",
            ];

            // Frame times per (pid, swap chain) in the current measurement window
            let mut frames: HashMap<Key, Vec<f32>> = HashMap::new();
            let mut key_name: HashMap<Key, String> = HashMap::new();
            let mut last_update = Instant::now();
            let mut last_fg: u32 = 0;

            let mut locked: Option<Key> = None;
            let mut locked_since = Instant::now(); // last time the locked key produced frames
            let mut challenger: Option<Key> = None;
            let mut challenger_wins: u8 = 0;

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

                let app = cols[app_idx].to_lowercase();

                // Only collect frame data for non-system processes
                if !ignore_list.iter().any(|&p| app == p) && !app.contains("antigravity") {
                    if let Ok(dt) = cols[ms_between_idx].parse::<f32>() {
                        if dt > 0.0 && dt < 1000.0 {
                            let pid = pid_idx
                                .and_then(|i| cols.get(i))
                                .and_then(|v| v.parse::<u32>().ok())
                                .unwrap_or(0);
                            let swap = swap_idx
                                .and_then(|i| cols.get(i))
                                .map(|v| v.to_string())
                                .unwrap_or_default();
                            let key = Key { pid, swap };
                            key_name.entry(key.clone()).or_insert_with(|| app.clone());
                            let entry = frames.entry(key).or_insert_with(Vec::new);
                            entry.push(dt);
                            if entry.len() > 120 {
                                entry.remove(0);
                            }
                        }
                    }
                }

                // Every 500ms, evaluate which app to report
                if last_update.elapsed() < Duration::from_millis(500) {
                    continue;
                }
                last_update = Instant::now();

                let fg = foreground_pid(&mut last_fg);

                // Score every active candidate. Foreground wins; the current lock gets a
                // small stickiness bonus so near-ties do not flip-flop; FPS is a capped tiebreak.
                // best = (key, score, fps, avg_dt)
                let mut best: Option<(Key, i32, f32, f32)> = None;
                let mut locked_stats: Option<(f32, f32)> = None;
                for (key, times) in &frames {
                    if times.len() < 3 {
                        continue;
                    }
                    let avg_dt = times.iter().sum::<f32>() / times.len() as f32;
                    let fps = 1000.0 / avg_dt;
                    if locked.as_ref() == Some(key) {
                        locked_stats = Some((fps, avg_dt));
                    }
                    if fps < 10.0 {
                        continue;
                    }
                    let mut score = (fps.min(240.0) / 10.0) as i32;
                    if key.pid != 0 && key.pid == fg {
                        score += 100;
                    }
                    if locked.as_ref() == Some(key) {
                        score += 5;
                    }
                    if debug {
                        println!(
                            "[PM] {} pid={} swap={} fps={:.0} score={}{}",
                            key_name.get(key).map(String::as_str).unwrap_or("?"),
                            key.pid, key.swap, fps, score,
                            if locked.as_ref() == Some(key) { " (locked)" } else { "" }
                        );
                    }
                    let better = best.as_ref().map_or(true, |b| {
                        score > b.1 || (score == b.1 && fps > b.2)
                    });
                    if better {
                        best = Some((key.clone(), score, fps, avg_dt));
                    }
                }

                match (&locked, best) {
                    // Nothing locked yet: take the best candidate.
                    (None, Some((key, _, fps, dt))) => {
                        println!(
                            "[PresentMon] Locked: {} pid={} ({:.0} FPS)",
                            key_name.get(&key).map(String::as_str).unwrap_or("?"), key.pid, fps
                        );
                        publish(&thread_data, fps, dt);
                        locked = Some(key);
                        locked_since = Instant::now();
                        challenger = None;
                        challenger_wins = 0;
                    }

                    // The locked key is also the best: keep reporting it.
                    (Some(cur), Some((key, _, fps, dt))) if *cur == key => {
                        publish(&thread_data, fps, dt);
                        locked_since = Instant::now();
                        challenger = None;
                        challenger_wins = 0;
                    }

                    // Someone else is winning: keep reporting the lock while it is active,
                    // and switch only after the challenger wins 2 windows in a row.
                    (Some(cur), Some((key, _, fps, dt))) => {
                        if let Some((lfps, ldt)) = locked_stats {
                            publish(&thread_data, lfps, ldt);
                            locked_since = Instant::now();
                        }
                        if challenger.as_ref() == Some(&key) {
                            challenger_wins += 1;
                        } else {
                            challenger = Some(key.clone());
                            challenger_wins = 1;
                        }
                        if challenger_wins >= 2 {
                            println!(
                                "[PresentMon] Switched: {} -> {} pid={} ({:.0} FPS)",
                                key_name.get(cur).map(String::as_str).unwrap_or("?"),
                                key_name.get(&key).map(String::as_str).unwrap_or("?"),
                                key.pid, fps
                            );
                            publish(&thread_data, fps, dt);
                            locked = Some(key);
                            locked_since = Instant::now();
                            challenger = None;
                            challenger_wins = 0;
                        }
                    }

                    // No candidate at all this window.
                    (Some(cur), None) => {
                        challenger = None;
                        challenger_wins = 0;
                        if let Some((lfps, ldt)) = locked_stats {
                            // below 10 FPS but still presenting: keep reporting it
                            publish(&thread_data, lfps, ldt);
                            locked_since = Instant::now();
                        } else if locked_since.elapsed() >= Duration::from_secs(2) {
                            println!(
                                "[PresentMon] Unlocked: {}",
                                key_name.get(cur).map(String::as_str).unwrap_or("?")
                            );
                            locked = None;
                            if let Ok(mut lock) = thread_data.lock() {
                                *lock = None;
                            }
                        }
                    }

                    (None, None) => {}
                }

                frames.clear();
                // forget names of keys that are neither locked nor challenging
                key_name.retain(|k, _| locked.as_ref() == Some(k) || challenger.as_ref() == Some(k));
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
