// ─────────────────────────────────────────────────────────────────────────────
// job.rs — make sidecar processes die together with this app (Windows)
//
// Children (lhm-sidecar.exe, PresentMon-x64.exe) are assigned to a Job Object
// flagged KILL_ON_JOB_CLOSE. The kernel closes our handle to the job when this
// process ends *for any reason* (window closed, crash, Task Manager, or
// `tauri dev` being stopped / restarting the app), and then terminates every
// process still in the job. Drop impls and window events never get that chance.
// ─────────────────────────────────────────────────────────────────────────────

use std::process::Child;

// BEGIN imp
#[cfg(target_os = "windows")]
mod imp {
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// The job handle lives for the whole process lifetime on purpose: it is never
    /// closed by us, only by the kernel when we exit. 0 = creation failed.
    static JOB: OnceLock<HANDLE> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        let h = *JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h == 0 {
                return 0;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(h);
                return 0;
            }
            h
        });
        (h != 0).then_some(h)
    }

    pub fn assign_raw(process: *mut c_void) -> bool {
        match job() {
            Some(j) => unsafe { AssignProcessToJobObject(j, process as HANDLE) != 0 },
            None => false,
        }
    }

    pub fn available() -> bool {
        job().is_some()
    }
}
// END imp

/// Tie `child`'s lifetime to ours. Returns false if that could not be arranged
/// (the caller may then fall back to killing it by name).
pub fn kill_on_exit(child: &Child) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::AsRawHandle;
        let ok = imp::assign_raw(child.as_raw_handle());
        if !ok {
            println!("[Job] Could not assign sidecar (pid {}) to the kill-on-exit job", child.id());
        }
        ok
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = child;
        false
    }
}

/// Whether the kill-on-exit job exists, i.e. sidecars will not outlive us.
pub fn available() -> bool {
    #[cfg(target_os = "windows")]
    {
        imp::available()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}
