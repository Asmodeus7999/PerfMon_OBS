// ─────────────────────────────────────────────────────────────────────────────
// presentmon.rs — FPS / frametime via the PresentMon sidecar (ETW, no injection)
//
// PresentMon prints one CSV row per presented frame for *every* process.
// We aggregate rows per (ProcessID, SwapChainAddress) in 500 ms windows and
// pick the game with a simple score (see `evaluate`): foreground window first,
// FPS only as a capped tiebreak, with hysteresis so the lock never flaps.
// ─────────────────────────────────────────────────────────────────────────────

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

/// Known non-game processes (lowercase). Matched against PresentMon's `Application` column.
const IGNORED_APPS: &[&str] = &[
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

const WINDOW: Duration = Duration::from_millis(500);
const IDLE_UNLOCK: Duration = Duration::from_secs(2);
const MIN_FRAMES: u32 = 3; // frames needed in a window before a key counts
const MIN_FPS: f32 = 10.0; // slower than this never wins a lock
const FOREGROUND_BONUS: i32 = 100;
const LOCK_BONUS: i32 = 5; // stickiness: stops near-ties from flip-flopping
const SWITCH_WINDOWS: u8 = 2; // challenger must win this many windows in a row

/// One swap chain of one process. Keying on the pair (not the exe name) keeps
/// frames from different swap chains of the same process from being averaged together.
#[derive(Hash, Eq, PartialEq, Clone, Copy, Debug)]
struct Key {
    pid: u32,
    swap: u64,
}

/// Per-key info that is resolved once, not on every CSV row.
struct Meta {
    name: String,
    ignored: bool,
}

/// Running totals for one key in the current window.
#[derive(Default, Clone, Copy)]
struct Acc {
    sum_ms: f32,
    frames: u32,
}

impl Acc {
    fn avg_dt(&self) -> Option<f32> {
        (self.frames >= MIN_FRAMES).then(|| self.sum_ms / self.frames as f32)
    }
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

fn publish(data: &Mutex<Option<FpsData>>, fps: f32, avg_dt: f32) {
    if let Ok(mut lock) = data.lock() {
        *lock = Some(FpsData {
            fps: (fps * 10.0).round() / 10.0,
            frame_time_ms: (avg_dt * 100.0).round() / 100.0,
        });
    }
}

fn clear(data: &Mutex<Option<FpsData>>) {
    if let Ok(mut lock) = data.lock() {
        *lock = None;
    }
}

fn name_of<'a>(known: &'a HashMap<Key, Meta>, key: &Key) -> &'a str {
    known.get(key).map(|m| m.name.as_str()).unwrap_or("?")
}

fn parse_swap(s: &str) -> u64 {
    u64::from_str_radix(s.trim().trim_start_matches("0x").trim_start_matches("0X"), 16).unwrap_or(0)
}

/// Lock / challenger state carried between windows.
#[derive(Default)]
struct Tracker {
    locked: Option<Key>,
    locked_since: Option<Instant>, // last time the locked key produced frames
    challenger: Option<Key>,
    challenger_wins: u8,
}

impl Tracker {
    fn set_lock(&mut self, key: Key) {
        self.locked = Some(key);
        self.locked_since = Some(Instant::now());
        self.challenger = None;
        self.challenger_wins = 0;
    }

    /// Run once per window: score candidates, update the lock, publish FPS.
    fn evaluate(
        &mut self,
        frames: &HashMap<Key, Acc>,
        known: &HashMap<Key, Meta>,
        fg: u32,
        debug: bool,
        out: &Mutex<Option<FpsData>>,
    ) {
        // best = (key, score, fps, avg_dt)
        let mut best: Option<(Key, i32, f32, f32)> = None;
        let mut locked_stats: Option<(f32, f32)> = None;

        for (key, acc) in frames {
            let Some(avg_dt) = acc.avg_dt() else { continue };
            let fps = 1000.0 / avg_dt;
            let is_locked = self.locked == Some(*key);
            if is_locked {
                locked_stats = Some((fps, avg_dt));
            }
            if fps < MIN_FPS {
                continue;
            }
            let mut score = (fps.min(240.0) / 10.0) as i32;
            if key.pid != 0 && key.pid == fg {
                score += FOREGROUND_BONUS;
            }
            if is_locked {
                score += LOCK_BONUS;
            }
            if debug {
                println!(
                    "[PM] {} pid={} swap={:#x} fps={:.0} score={}{}",
                    name_of(known, key), key.pid, key.swap, fps, score,
                    if is_locked { " (locked)" } else { "" }
                );
            }
            let better = best
                .as_ref()
                .map_or(true, |b| score > b.1 || (score == b.1 && fps > b.2));
            if better {
                best = Some((*key, score, fps, avg_dt));
            }
        }

        match (self.locked, best) {
            // Nothing locked yet: take the best candidate.
            (None, Some((key, _, fps, dt))) => {
                println!("[PresentMon] Locked: {} pid={} ({:.0} FPS)", name_of(known, &key), key.pid, fps);
                publish(out, fps, dt);
                self.set_lock(key);
            }

            // The locked key is also the best: keep reporting it.
            (Some(cur), Some((key, _, fps, dt))) if cur == key => {
                publish(out, fps, dt);
                self.set_lock(key);
            }

            // Someone else is winning: keep reporting the lock while it is active,
            // and switch only after the challenger wins several windows in a row.
            (Some(cur), Some((key, _, fps, dt))) => {
                if let Some((lfps, ldt)) = locked_stats {
                    publish(out, lfps, ldt);
                    self.locked_since = Some(Instant::now());
                }
                if self.challenger == Some(key) {
                    self.challenger_wins += 1;
                } else {
                    self.challenger = Some(key);
                    self.challenger_wins = 1;
                }
                if self.challenger_wins >= SWITCH_WINDOWS {
                    println!(
                        "[PresentMon] Switched: {} -> {} pid={} ({:.0} FPS)",
                        name_of(known, &cur), name_of(known, &key), key.pid, fps
                    );
                    publish(out, fps, dt);
                    self.set_lock(key);
                }
            }

            // No candidate at all this window.
            (Some(cur), None) => {
                self.challenger = None;
                self.challenger_wins = 0;
                if let Some((lfps, ldt)) = locked_stats {
                    // below MIN_FPS but still presenting: keep reporting it
                    publish(out, lfps, ldt);
                    self.locked_since = Some(Instant::now());
                } else if self.locked_since.map_or(true, |t| t.elapsed() >= IDLE_UNLOCK) {
                    println!("[PresentMon] Unlocked: {}", name_of(known, &cur));
                    self.locked = None;
                    clear(out);
                }
            }

            (None, None) => {}
        }
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
        cmd.args(["--output_stdout", "--stop_existing_session"])
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
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if !line.is_empty() {
                        println!("[PresentMon-stderr] {}", line);
                    }
                }
            });
        }

        let stdout = child.stdout.take()?;
        let latest_data = Arc::new(Mutex::new(None));
        let thread_data = latest_data.clone();

        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();

            // Read header and locate the columns we need
            if reader.read_line(&mut line).is_err() || line.is_empty() {
                println!("[PresentMon] Failed to read CSV header.");
                return;
            }
            let headers: Vec<&str> = line.trim().split(',').collect();
            let col = |name: &str| headers.iter().position(|&h| h == name);
            let (Some(app_idx), Some(pid_idx), Some(ms_idx)) =
                (col("Application"), col("ProcessID"), col("MsBetweenPresents"))
            else {
                println!("[PresentMon] Missing required CSV columns (Application/ProcessID/MsBetweenPresents).");
                return;
            };
            let swap_idx = col("SwapChainAddress"); // optional
            let max_idx = [app_idx, pid_idx, ms_idx, swap_idx.unwrap_or(0)]
                .into_iter()
                .max()
                .unwrap_or(0);
            let debug = std::env::var("PERFMON_PM_DEBUG").is_ok();

            let mut frames: HashMap<Key, Acc> = HashMap::new(); // this window only
            let mut known: HashMap<Key, Meta> = HashMap::new(); // resolved once per key
            let mut tracker = Tracker::default();
            let mut last_update = Instant::now();
            let mut last_fg: u32 = 0;

            loop {
                line.clear();
                if reader.read_line(&mut line).is_err() || line.is_empty() {
                    println!("[PresentMon] stdout closed.");
                    break;
                }

                // Single pass over the row, no per-row Vec/String allocations.
                let (mut app, mut pid, mut swap, mut dt) = (None, None, None, None);
                for (i, field) in line.trim_end().split(',').enumerate() {
                    if i == app_idx {
                        app = Some(field);
                    } else if i == pid_idx {
                        pid = field.parse::<u32>().ok();
                    } else if i == ms_idx {
                        dt = field.parse::<f32>().ok();
                    } else if Some(i) == swap_idx {
                        swap = Some(parse_swap(field));
                    }
                    if i >= max_idx {
                        break;
                    }
                }

                if let (Some(app), Some(pid), Some(dt)) = (app, pid, dt) {
                    if dt > 0.0 && dt < 1000.0 {
                        let key = Key { pid, swap: swap.unwrap_or(0) };
                        let meta = known.entry(key).or_insert_with(|| {
                            let name = app.to_lowercase();
                            let ignored = IGNORED_APPS.contains(&name.as_str()) || name.contains("antigravity");
                            Meta { name, ignored }
                        });
                        if !meta.ignored {
                            let acc = frames.entry(key).or_default();
                            acc.sum_ms += dt;
                            acc.frames += 1;
                        }
                    }
                }

                if last_update.elapsed() < WINDOW {
                    continue;
                }
                last_update = Instant::now();

                let fg = foreground_pid(&mut last_fg);
                tracker.evaluate(&frames, &known, fg, debug, &thread_data);
                frames.clear();

                // Keep the name cache bounded (short-lived processes create many keys).
                if known.len() > 1024 {
                    known.retain(|k, _| tracker.locked == Some(*k) || tracker.challenger == Some(*k));
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
