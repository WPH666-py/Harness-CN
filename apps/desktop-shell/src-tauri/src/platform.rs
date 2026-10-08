// Single-instance claim and fatal-error dialog for the Harness-CN shell.
//
// Both are done through `windows-sys` rather than a Tauri plugin: the shell needs exactly three
// Win32 calls, and a plugin would add a JavaScript API and a runtime to a process that uses
// neither. Nothing here depends on the Windows version.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::Mutex;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, MessageBoxW, SetForegroundWindow, ShowWindow, MB_ICONERROR, MB_OK, SW_RESTORE,
};

/// Name of the mutex that stands for "a Harness-CN shell is running on this desktop".
const INSTANCE_MUTEX: &str = "Local\\Harness-CN-Shell";

/// Title every Harness-CN top-level window carries, used to find the running instance.
const WINDOW_TITLE: &str = "Harness-CN";

/// Claim handle, kept so an in-place restart can hand the slot to its replacement.
static INSTANCE: Mutex<isize> = Mutex::new(0);

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
