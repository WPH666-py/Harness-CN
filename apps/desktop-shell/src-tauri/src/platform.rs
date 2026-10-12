// Single-instance claim, process-tree containment, and fatal-error dialog for the Harness-CN shell.
//
// All three are done through `windows-sys` rather than a Tauri plugin: the shell needs a handful
// of Win32 calls, and a plugin would add a JavaScript API and a runtime to a process that uses
// neither. Nothing here depends on the Windows version.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::Mutex;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    CreateMutexW, GetCurrentProcessId, OpenProcess, TerminateProcess,
    PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowW, GetWindowThreadProcessId, IsWindowVisible, MessageBoxW,
    SetForegroundWindow, ShowWindow, MB_ICONERROR, MB_OK, SW_RESTORE,
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
/// `JOB_OBJECT_LIMIT_BREAKAWAY_OK` is also set, and it is not optional. One process this product
/// starts must outlive the shell: the NSIS installer the updater launches. Without breakaway the
/// installer is a member of this job like any other child, so the shell's own exit closes the job
/// and terminates it — which is exactly how an in-product update ends up downloaded, verified, and
/// never applied. The flag only permits breakaway; a child still has to request it, so every other
/// process an agent starts stays contained.
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
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
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

/// Largest value `ShellExecuteW` returns when it refused the request.
///
/// The call is declared to return an `HINSTANCE` and is documented to return an error code instead:
/// anything above this bound is a handle to the program that was started.
const SHELL_EXECUTE_ERROR_LIMIT: isize = 32;

/// Open one address in the platform's default browser.
///
/// `ShellExecuteW` is the shell's own "open this" call, so the address lands in whatever the user
/// has set as their browser rather than in a program this build would have to choose. The shell
/// process is a GUI-subsystem binary with no console, which is why this goes through the shell
/// rather than a command line: a console-subsystem fallback would flash a window on every click.
/// @param address - absolute http/https address to open.
/// @returns whether the platform accepted the request.
pub fn open_external(address: &str) -> bool {
    /// `SW_SHOWNORMAL`: show the target in the state it was last left in.
    const SW_SHOWNORMAL: i32 = 1;
    let operation = wide("open");
    let file = wide(address);
    let opened = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    let code = opened as isize;
    if code <= SHELL_EXECUTE_ERROR_LIMIT {
        eprintln!("Harness-CN: opening {address} in the browser failed (ShellExecuteW code {code})");
        return false;
    }
    true
}

/// Start the downloaded installer outside this process's job object.
///
/// The updater cannot do this itself. Node's `spawn(..., { detached: true })` sets only
/// `CREATE_NEW_PROCESS_GROUP` on Windows, which does not leave a job, so an installer started that
/// way dies with the shell that started it — the update is downloaded, verified, reported as
/// installed, and never applied. `CREATE_BREAKAWAY_FROM_JOB` is the flag that actually leaves, and
/// it can only be set by the process calling `CreateProcess`, which is this one.
///
/// The caller is expected to exit immediately afterwards. Nothing here waits on the installer: it
/// is the installer's own job to replace the files, and this process holds the very executable it
/// replaces.
/// @param installer - absolute path of the installer executable.
/// @param silent_switch - argument that makes the installer run unattended (NSIS `/S`).
/// @returns whether the installer started.
pub fn spawn_installer(installer: &Path, silent_switch: &str) -> bool {
    /// `CREATE_BREAKAWAY_FROM_JOB`: start outside the job this process is contained in.
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    match Command::new(installer)
        .arg(silent_switch)
        .creation_flags(CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
    {
        Ok(_child) => true,
        Err(error) => {
            eprintln!("Harness-CN: the installer could not be started: {error}");
            false
        }
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
/// One top-level window belonging to this process, collected by {@link enum_callback}.
#[derive(Default)]
struct OwnWindow {
    /// The most recently seen visible top-level window, or zero.
    handle: HWND,
}

/// Pick out this process's own visible top-level window.
///
/// The window is identified by its owning process rather than by its title. A title is not a
/// stable identity here: the workspace window renders the Host's web interface, and WebView2
/// rewrites the window title from the page's own `<title>` once that page loads, so a lookup by
/// the title this shell set at creation stops matching the moment the page arrives.
/// @param window - candidate top-level window.
/// @param param - pointer to the {@link OwnWindow} collecting the answer.
/// @returns always 1, to keep enumerating (the caller keeps the last visible match).
unsafe extern "system" fn enum_callback(window: HWND, param: LPARAM) -> i32 {
    let found = unsafe { &mut *(param as *mut OwnWindow) };
    let mut owner = 0u32;
    unsafe { GetWindowThreadProcessId(window, &mut owner) };
    if owner == unsafe { GetCurrentProcessId() } && unsafe { IsWindowVisible(window) } != 0 {
        found.handle = window;
    }
    1
}

/// Bring this product's existing window forward.
///
/// Called by a second launch that lost the single-instance claim, so its only job is to make the
/// running instance visible: it restores a minimized window and raises it. A window that is not
/// found is not an error — there may be no window yet while the first launch is still installing
/// — and the process simply exits, leaving the instance that owns the claim alone.
pub fn focus_running_instance() {
    let mut found = OwnWindow::default();
    unsafe {
        EnumWindows(Some(enum_callback), std::ptr::from_mut(&mut found) as LPARAM);
    }
    if found.handle.is_null() {
        // Fall back to the creation-time title for a window this process did not create: a
        // release older than this one may still be the running instance.
        let title = wide(WINDOW_TITLE);
        let window = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
        if window.is_null() {
            return;
        }
        unsafe {
            ShowWindow(window, SW_RESTORE);
            SetForegroundWindow(window);
        }
        return;
    }
    unsafe {
        ShowWindow(found.handle, SW_RESTORE);
        SetForegroundWindow(found.handle);
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
