// Single-instance claim, process-tree containment, and fatal-error dialog for the Harness-CN shell.
//
// All three are done through `windows-sys` rather than a Tauri plugin: the shell needs a handful
// of Win32 calls, and a plugin would add a JavaScript API and a runtime to a process that uses
// neither. Nothing here depends on the Windows version.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::process::Child;
use std::sync::Mutex;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    CreateMutexW, OpenProcess, TerminateProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, MessageBoxW, SetForegroundWindow, ShowWindow, MB_ICONERROR, MB_OK, SW_RESTORE,
};

/// Name of the mutex that stands for "a Harness-CN shell is running on this desktop".
const INSTANCE_MUTEX: &str = "Local\\Harness-CN-Shell";

/// Title every Harness-CN top-level window carries, used to find the running instance.
const WINDOW_TITLE: &str = "Harness-CN";

/// Claim handle, kept so an in-place restart can hand the slot to its replacement.
static INSTANCE: Mutex<isize> = Mutex::new(0);

/// Job object holding the Node sidecar and every process it starts, or zero when containment failed.
///
/// The handle is deliberately never closed: `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is what turns
/// "this process ended" into "everything this product started ends", and Windows closes the handle
/// when the process dies however it dies — an ordinary exit, a crash, or a kill from Task Manager.
static JOB: Mutex<isize> = Mutex::new(0);

/// Put one freshly spawned sidecar and every process it will start into a kill-on-close job.
///
/// Without this, the shell can only kill the sidecar itself. The sidecar's own children — the dsh
/// Host, the pnpm installs it runs, and everything an agent spawns under them — are then orphaned
/// on every exit that does not reach the graceful path: they keep their ports, their file handles,
/// and their half-finished work while the next launch contends with them.
///
/// The job is created once and reused, and the sidecar is spawned suspended by the caller so it
/// cannot start a child before it is inside the job.
/// @param child - the suspended sidecar process.
/// @returns whether the process is now contained; false means the caller keeps its kill fallback.
pub fn contain_process_tree(child: &Child) -> bool {
    let handle = unsafe {
        let mut current = JOB.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if *current == 0 {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return false;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let applied = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                u32::try_from(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()).unwrap_or(0),
            );
            if applied == 0 {
                CloseHandle(job);
                return false;
            }
            *current = job as isize;
        }
        *current as _
    };
    // The handle is opened by pid rather than taken from the child: `AssignProcessToJobObject`
    // wants the access rights this process would have to request for itself either way, and a
    // handle this function owns is a handle this function closes.
    let process = unsafe {
        OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.id())
    };
    if process.is_null() {
        eprintln!("Harness-CN: the sidecar process could not be opened for containment");
        return false;
    }
    // A process already inside a job that forbids nesting cannot be moved into this one. That is a
    // narrower failure than it looks: it is reported, and the graceful stop still covers the
    // sidecar and the Host it owns.
    let assigned = unsafe { AssignProcessToJobObject(handle, process) };
    let error = if assigned == 0 { unsafe { GetLastError() } } else { 0 };
    unsafe { CloseHandle(process) };
    if error != 0 {
        eprintln!(
            "Harness-CN: the sidecar could not be contained in a job object (error {error}); \
             a hard kill may leave the Host behind"
        );
        return false;
    }
    true
}

/// Terminate one process without waiting for it, tolerating a process that has already exited.
///
/// This is the backstop for a sidecar that ignored its graceful stop, and it is what makes the job
/// object the only owner of the tree: killing the sidecar by its own handle is safe because the job
/// closes with this process either way.
/// @param pid - process id of the child to end.
pub fn terminate(pid: u32) {
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if handle.is_null() {
        return;
    }
    unsafe {
        TerminateProcess(handle, 1);
        CloseHandle(handle);
    }
}

fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(std::iter::once(0)).collect()
}

/// Take this desktop's single Harness-CN slot.
///
/// The handle is retained rather than leaked because the restart action has to give the slot up
/// before it starts the replacement, and a replacement that found the slot still taken would
/// exit immediately and leave the user with nothing.
/// @returns whether this process is the one that owns the slot.
pub fn claim_single_instance() -> bool {
    let name = wide(INSTANCE_MUTEX);
    // `CreateMutexW` reports "somebody else already owns this name" through the thread's
    // last-error value, and that value is whatever the previous API call in this process left
    // there. Without clearing it, an unrelated stale error reads as "an instance is running",
    // and the shell exits before showing anything at all.
    unsafe { SetLastError(0) };
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        // A mutex that cannot be created is not a reason to refuse to start.
        return true;
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { CloseHandle(handle) };
        return false;
    }
    if let Ok(mut current) = INSTANCE.lock() {
        *current = handle as isize;
    }
    true
}

/// Give up this desktop's slot so a replacement process can take it.
pub fn release_single_instance() {
    let Ok(mut current) = INSTANCE.lock() else { return };
    let handle = *current;
    if handle != 0 {
        unsafe { CloseHandle(handle as _) };
        *current = 0;
    }
}

/// Bring the running instance's main window to the front.
///
/// A second launch is the user asking for the application, so the existing window is restored
/// and focused instead of a second copy being started.
pub fn focus_running_instance() {
    let title = wide(WINDOW_TITLE);
    let window = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
    if window.is_null() {
        return;
    }
    unsafe {
        ShowWindow(window, SW_RESTORE);
        SetForegroundWindow(window);
    }
}

/// Show a modal error dialog owned by no window.
///
/// Used for the failures that happen before there is a window to render them in, which is
/// exactly the case a shell cannot report any other way.
/// @param title - dialog caption.
/// @param message - dialog body.
pub fn show_error(title: &str, message: &str) {
    let caption = wide(title);
    let body = wide(message);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}
