//! Process cleanup — Windows Job Object guard.
//!
//! Assigns the node sidecar to a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
//! If the main process dies (even via Task Manager force-kill), the kernel reaps
//! the child when the leaked job handle closes on parent exit. No-op on non-Windows.
//!
//! This guards the force-kill edge case only; the normal close-window path is
//! handled by the `RunEvent::Exit` hook in main.rs calling `child.kill()`.

#[cfg(windows)]
pub fn assign_to_job(pid: u32) {
    if let Err(e) = windows_job::assign(pid) {
        log::warn!("job object assignment failed for pid {pid}: {e}");
    }
}

#[cfg(not(windows))]
pub fn assign_to_job(_pid: u32) {}

#[cfg(windows)]
mod windows_job {
    use std::mem::{size_of, zeroed};

    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    pub fn assign(pid: u32) -> Result<(), String> {
        unsafe {
            let job = CreateJobObjectW(None, None).map_err(|e| format!("CreateJobObjectW: {e}"))?;

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|e| format!("SetInformationJobObject: {e}"))?;

            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(|e| format!("OpenProcess({pid}): {e}"))?;

            let assigned =
                AssignProcessToJobObject(job, proc).map_err(|e| format!("AssignProcessToJobObject: {e}"));

            let _ = CloseHandle(proc); // only needed for the assign call

            assigned?;

            // HANDLE is Copy with no Drop impl, so `job` never closes on its own —
            // it stays open for the parent's lifetime, which is exactly what makes
            // the kernel kill the child when we exit. Do NOT CloseHandle(job).
            Ok(())
        }
    }
}
