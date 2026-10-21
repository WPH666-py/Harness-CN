// Harness-CN desktop shell.
//
// The shell owns exactly three things: the windows, the menu bar, and the lifetime of the
// bundled Node sidecar. Everything about the product itself — the desktop project transaction,
// the seed transport, the Host process, the credential gate, and the release channel — is Node
// code the sidecar runs, which is why this file can stay this small.
//
// The two halves talk over the sidecar's standard streams in both directions rather than over
// HTTP or an IPC bridge: the sidecar reports what it knows as JSON lines on stdout, and the
// shell asks for the operations only the sidecar can perform as JSON lines on stdin. Nothing
// here needs an HTTP client, and nothing in the webview needs an API surface of its own.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod platform;

use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Windows creation flag that keeps a console-subsystem child from opening a console window.
///
/// This shell is a GUI-subsystem process, but `node.exe` is not: starting it the ordinary way
/// allocates a console for it, and the user sees a black command window sitting behind the
/// product for as long as the application runs. The sidecar has no use for a console — its
/// stdout and stderr are pipes this shell reads — so the window is suppressed at creation.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How long the sidecar is given to stop the Host and exit on its own before it is killed.
///
/// The Host's own stop allows 20 seconds for a graceful shutdown, but waiting that long past the
/// last window would read as a product that will not close. The sidecar stops the Host first and
/// only then exits, so this window is the Host's stop plus the two file flushes after it; a Host
/// that genuinely needs longer is exactly the one the job object is there for.
const GRACEFUL_STOP: Duration = Duration::from_secs(12);

/// Window label of the launch progress window.
const SPLASH: &str = "splash";
/// Window label of the workspace window that renders the Host's web interface.
const MAIN: &str = "main";
/// Window label of the DeepSeek credential gate.
const API_KEY: &str = "api-key";
/// Window label of the installed-plugin manager.
const PLUGINS: &str = "plugins";
/// Menu id and window label of the QQ group console, which lives in the workspace page.
const QQ_CONSOLE: &str = "qq-console";
/// Menu id of the server manager window.
const SERVERS: &str = "servers";
/// Window label of the mobile-access window.
const LAN: &str = "lan";
/// Window label of the run-log viewer.
const LOGS: &str = "logs";
/// Window label of the release prompt.
const UPDATE: &str = "update";
/// Window label of the author card.
const AUTHOR: &str = "author";
/// Window label of the snack shop.
const SHOP: &str = "shop";
/// Window label of the feedback form.
const FEEDBACK: &str = "feedback";

/// Id of the notification-area icon the shell keeps alive.
const TRAY_ID: &str = "harness-cn-tray";
/// Tray menu entry that brings the hidden workspace window back.
const TRAY_SHOW_ID: &str = "tray-show";
/// Tray menu entry that flips what closing the workspace window does.
const TRAY_KEEP_ID: &str = "tray-keep";
/// Tray menu entry that ends the product for real.
/// Set once the process is on its way out, so the window-closed rule stops guarding the exit.
static QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether closing the workspace window keeps the product running in the notification area.
///
/// Opening the workspace costs a full plugin-tree start — tens of seconds cold — so the default is
/// to keep it: the window hides and the next open is immediate. The tray entry flips this, and the
/// choice is written to the installation's data directory so it survives a restart.
static KEEP_IN_TRAY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

const TRAY_QUIT_ID: &str = "tray-quit";
/// Caption the tray tooltip and the fallback window lookup share.
const APP_NAME: &str = "Harness-CN";

/// Owned children, the port the sidecar published, and the account of a failed launch.
#[derive(Default)]
struct Shell {
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
    /// Port the shell's own windows answer on, separate from the workspace origin.
    shell_port: Mutex<Option<u16>>,
    /// Whether the sidecar ever reported a usable workspace.
    ready: std::sync::atomic::AtomicBool,
    /// Tail of the sidecar's own diagnostics, shown when it dies before that.
    diagnostics: Mutex<String>,
    /// Why the last release check failed, kept until a check succeeds.
    ///
    /// The automatic check runs without the user asking, so its failure has no dialog to land in.
    /// Keeping it here is what lets the menu entry report it — both as a marker that an update
    /// check is failing and, when the user follows that marker, as the reason itself.
    update_failure: Mutex<Option<String>>,
}

/// Menu entry id and label of the release check.
const UPDATE_MENU_ID: &str = "updates";
const UPDATE_MENU_LABEL: &str = "检查更新";

/// Text the menu entry carries while the last check failed.
///
/// A marker rather than a sentence: the menu bar is not the place to explain a network failure, and
/// the explanation is one click away. Product copy stays Chinese here because the whole menu bar is
/// authored in the shell, which has no locale of its own.
const UPDATE_MENU_LABEL_FAILED: &str = "检查更新 [!]";

/// One line the sidecar wrote to its stdout.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Handshake {
    /// The control surface is listening, so the progress window can be shown.
    Listen {
        port: u16,
        /// The shell origin's port; absent from a sidecar older than this field.
        #[serde(rename = "shellPort", default)]
        shell_port: Option<u16>,
    },
    /// The launch advanced; the progress window reads the same value from the control surface.
    Status {
        #[allow(dead_code)]
        status: serde_json::Value,
    },
    /// The workspace is ready to be shown.
    Ready {
        port: u16,
        /// The shell origin's port; see `Listen`.
        #[serde(rename = "shellPort", default)]
        shell_port: Option<u16>,
        #[serde(rename = "needsApiKey")]
        needs_api_key: bool,
    },
    /// The release channel changed state.
    Update { state: UpdateState },
    /// The updater downloaded an installer and needs it started outside this process's job.
    ///
    /// Only the shell can do this: leaving a job needs `CREATE_BREAKAWAY_FROM_JOB` at
    /// `CreateProcess` time, and the sidecar's own `spawn` cannot set it. The sidecar exits right
    /// after sending this, so the installer is what continues the update.
    LaunchInstaller {
        #[serde(rename = "installer")]
        installer: String,
        #[serde(rename = "silentSwitch")]
        silent_switch: String,
    },
    /// A fact the user has to be told about, raised by a menu action.
    Message { title: String, body: String },
    /// The launch failed and there is no window that could report it.
    Fatal { message: String },
    /// A page the shell serves asked for a restart — the same action the window menu offers.
    ///
    /// The request has to come back here: the single-instance claim and the process being replaced
    /// both belong to this process, which the sidecar cannot reach.
    Restart,
}

/// The subset of the release-channel state the shell acts on.
#[derive(Deserialize)]
struct UpdateState {
    phase: String,
    #[serde(default)]
    version: Option<String>,
    /// Why the check failed, present on an `error` phase.
    #[serde(default)]
    message: Option<String>,
}

fn origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Port the shell's own windows answer on, falling back to the workspace port.
///
/// A sidecar older than this field publishes only one port; the shell windows then share the
/// workspace origin as they always did.
fn shell_port_of(app: &AppHandle) -> Option<u16> {
    app.state::<Shell>()
        .shell_port
        .lock()
        .ok()
        .and_then(|value| *value)
        .or_else(|| app.state::<Shell>().port.lock().ok().and_then(|value| *value))
}

/// Origin the shell's own windows load from.
///
/// The workspace origin is shared with the app page, which holds five event streams plus a plugin
/// long-poll — six, which is a browser's whole budget per origin. A shell page opened there waits
/// forever for a connection and renders as a blank window, so the sidecar publishes a second
/// loopback port for `/shell/*` and this is the origin that uses it.
fn shell_origin(app: &AppHandle, published: Option<u16>) -> String {
    match published.or_else(|| shell_port_of(app)) {
        Some(port) => origin(port),
        None => origin(0),
    }
}

/// Convert a Windows verbatim path back to the ordinary form.
///
/// Tauri's path APIs — and `std::fs::canonicalize` — answer with `\\?\C:\...` on Windows, which
/// is a valid path for Win32 but not for every consumer. Node is one that cannot read it: its
/// module loader resolves `\\?\C:\...` to the bare drive `C:` and then dies looking for its own
/// entry point (`EISDIR: lstat 'C:'`). Every path this shell hands to the sidecar therefore has
/// to be converted first, and the conversion is done once, at the point the path is obtained.
/// @param path - path as a Windows API returned it.
/// @returns the same path without its verbatim prefix.
fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// Create one shell window, or bring the existing one forward.
///
/// Every window is loaded from the sidecar's own loopback origin, and navigation away from that
/// origin is refused: the pages the shell owns are the only ones it can render, and an external
/// link inside the product must not be able to replace the workspace with a foreign page.
///
/// A page asking for a new window is a different request, and the snack shop is the page that makes
/// it: every product it lists is a link to a Pinduoduo product page marked `target="_blank"`. The
/// webview has no second window to put those in, so the request is answered by handing the address
/// to the platform's own browser — which is where a shop link belongs anyway, since the purchase
/// happens there. Refusing the request instead is what made a click on a product do nothing at all.
fn open_window(
    app: &AppHandle,
    label: &str,
    url: String,
    title: &str,
    width: f64,
    height: f64,
    resizable: bool,
) -> Option<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Some(existing);
    }
    let parsed = tauri::Url::parse(&url).ok()?;
    // Every window this shell opens is recorded before it is built: a window that renders the wrong
    // thing is then diagnosable from the run log, which is where a user can look, rather than only
    // from a console no build carries.
    eprintln!("Harness-CN: opening window {label} at {url}");
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(560.0, 420.0)
        .resizable(resizable)
        .center()
        .visible(true)
        .on_navigation(|target| target.host_str() == Some("127.0.0.1"))
        .on_new_window(|target, _features| {
            open_in_browser(&target);
            // The page keeps rendering in the window it was loaded in; the address was either
            // handed to the browser or reported, and neither outcome leaves a window to show.
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .ok()
        .map(|window| {
            // The app menu belongs to the main window: this platform installs it once for the whole
            // application and every window shows it. The auxiliary windows are one page each and have
            // no command of their own, so the menu there only offers entries that act on a window the
            // user is not looking at.
            if window.label() != MAIN {
                let _ = window.remove_menu();
            }
            window
        })
}

/// Hand one address a page asked to open to the platform's own browser.
///
/// Only the two browser schemes are passed on, and a loopback address is refused: it names a
/// listener on this machine, which the shell already renders in its own windows, and on Windows it
/// is the shape that makes a shell execute association look like a harmless link. Anything else is
/// reported to the user rather than swallowed, because a link that does nothing is the failure this
/// exists to remove.
/// @param target - address the page asked for a new window for.
fn open_in_browser(target: &tauri::Url) {
    let allowed = matches!(target.scheme(), "http" | "https")
        && !target.host_str().is_some_and(|host| host == "127.0.0.1" || host == "localhost");
    if !allowed || !platform::open_external(target.as_str()) {
        platform::show_error(
            "Harness-CN",
            &format!("无法在浏览器中打开这个链接：\n{}", target.as_str()),
        );
    }
}

/// Replace this process with a fresh copy of itself.
///
/// The single-instance claim belongs to this process, so it has to be given up before the
/// replacement starts; otherwise the new process sees a running shell and leaves.
fn restart_shell(app: &AppHandle) {
    platform::release_single_instance();
    match std::env::current_exe().map(|exe| Command::new(exe).spawn()) {
        Ok(Ok(_)) => app.exit(0),
        _ => platform::show_error("Harness-CN", "无法重新启动应用，请手动退出后重新打开。"),
    }
}

/// Apply one fact the sidecar reported.
fn apply_handshake(app: &AppHandle, message: Handshake) {
    match message {
        Handshake::Listen { port, shell_port } => {
            if let Ok(mut current) = app.state::<Shell>().port.lock() {
                *current = Some(port);
            }
            if let (Some(shell), Ok(mut current)) = (shell_port, app.state::<Shell>().shell_port.lock()) {
                *current = Some(shell);
            }
            open_window(
                app,
                SPLASH,
                format!("{}/shell/startup.html", shell_origin(app, shell_port)),
                "Harness-CN 正在启动",
                520.0,
                560.0,
                false,
            );
        }
        Handshake::Status { .. } => {}
        Handshake::Restart => restart_shell(app),
        Handshake::Ready { port, shell_port, needs_api_key } => {
            if let Ok(mut current) = app.state::<Shell>().port.lock() {
                *current = Some(port);
            }
            if let (Some(shell), Ok(mut current)) = (shell_port, app.state::<Shell>().shell_port.lock()) {
                *current = Some(shell);
            }
            app.state::<Shell>().ready.store(true, std::sync::atomic::Ordering::SeqCst);
            if let Some(splash) = app.get_webview_window(SPLASH) {
                let _ = splash.destroy();
            }
            install_menu(app);
            open_window(app, MAIN, format!("{}/", origin(port)), "Harness-CN", 1280.0, 840.0, true);
            if needs_api_key {
                open_window(
                    app,
                    API_KEY,
                    format!("{}/shell/api-key.html", shell_origin(app, shell_port)),
                    "绑定 DeepSeek 密钥",
                    560.0,
                    520.0,
                    false,
                );
            }
        }
        Handshake::Update { state } => {
            // The menu says whether the last check succeeded, and remembers why it did not: a
            // failure nobody asked for is otherwise invisible until the user thinks to check.
            let failure = if state.phase == "error" {
                state.message.clone().or_else(|| Some("检查更新失败，未提供原因。".to_string()))
            } else if state.phase == "available" || state.phase == "idle" {
                None
            } else {
                app.state::<Shell>().update_failure.lock().ok().and_then(|held| held.clone())
            };
            if let Ok(mut held) = app.state::<Shell>().update_failure.lock() {
                *held = failure.clone();
            }
            set_update_menu_label(app, failure.is_some());
            // The prompt exists to offer a release or to report one being installed. An `idle` or
            // `error` check has its own answers — the menu item reports both through a dialog —
            // and opening a window for those would put a dialog about nothing on the user's
            // desktop. A prompt already on screen is left alone: the page renders every later
            // state from the control surface's own event stream, so reopening it would only
            // discard the download progress it is showing.
            if state.phase != "available" && state.phase != "installing" {
                return;
            }
            if app.get_webview_window(UPDATE).is_some() {
                return;
            }
            if shell_port_of(app).is_none() {
                return;
            }
            let version = state.version.unwrap_or_default();
            open_window(
                app,
                UPDATE,
                format!("{}/shell/update.html?v={version}", shell_origin(app, None)),
                "发现新版本",
                620.0,
                620.0,
                false,
            );
        }
        Handshake::LaunchInstaller { installer, silent_switch } => {
            // The path comes over the sidecar's stdout, so it is validated rather than trusted: an
            // absolute existing `.exe` is the whole shape an installer has, and anything else is
            // refused with a dialog instead of being spawned.
            let path = PathBuf::from(installer.replace('/', "\\"));
            let usable = path.is_absolute()
                && path.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"));
            if !usable {
                platform::show_error(
                    "Harness-CN 更新失败",
                    &format!("安装程序路径不可用：\n{}", path.display()),
                );
                return;
            }
            if !platform::spawn_installer(&path, &silent_switch) {
                platform::show_error(
                    "Harness-CN 更新失败",
                    &format!(
                        "无法启动安装程序：\n{}\n\n安装包仍在下载目录中，可以手动运行它完成更新。",
                        path.display(),
                    ),
                );
            }
        }
        Handshake::Message { title, body } => platform::show_error(&title, &body),
        Handshake::Fatal { message } => {
            platform::show_error("Harness-CN 启动失败", &message);
            app.exit(1);
        }
    }
}

/// The shell's menu bar.
///
/// One flat list of actions, matching the Electron build it replaces: every entry does something,
/// so no submenu carries the application name as a label.
fn install_menu(app: &AppHandle) {
    let build = || -> tauri::Result<()> {
        let menu = MenuBuilder::new(app)
            .item(&MenuItemBuilder::with_id("restart", "重启").build(app)?)
            .item(&MenuItemBuilder::with_id("lan", "移动访问").build(app)?)
        .item(&MenuItemBuilder::with_id("logs", "运行日志").build(app)?)
            .item(&MenuItemBuilder::with_id("plugins", "插件管理").build(app)?)
            .item(&MenuItemBuilder::with_id("qq-console", "QQ 群管理").build(app)?)
            .item(&MenuItemBuilder::with_id("updates", "检查更新").build(app)?)
            .item(&MenuItemBuilder::with_id("api-key", "API 密钥").build(app)?)
            .item(&MenuItemBuilder::with_id("author", "作者信息").build(app)?)
            .item(&MenuItemBuilder::with_id("shop", "休闲食品商城").build(app)?)
            .item(&MenuItemBuilder::with_id("feedback", "评价与反馈").build(app)?)
            .item(&MenuItemBuilder::with_id("devtools", "开发者工具").build(app)?)
            .item(&MenuItemBuilder::with_id("servers", "服务器管理").build(app)?)
            .build()?;
        app.set_menu(menu)?;
        Ok(())
    };
    if let Err(error) = build() {
        eprintln!("Harness-CN: the menu bar could not be installed: {error}");
    }
}

/// Show whether the last release check succeeded on the menu entry that starts one.
///
/// The entry is the only place a check that nobody asked for can report itself: the automatic check
/// publishes no dialog, and a user who never opens the update window would otherwise have no way to
/// learn that this machine has stopped being offered releases.
/// @param app - handle owning the menu bar.
/// @param failed - whether the last check failed and its reason is being held.
fn set_update_menu_label(app: &AppHandle, failed: bool) {
    let Some(menu) = app.menu() else { return };
    let Some(tauri::menu::MenuItemKind::MenuItem(item)) = menu.get(UPDATE_MENU_ID) else { return };
    let label = if failed { UPDATE_MENU_LABEL_FAILED } else { UPDATE_MENU_LABEL };
    if let Err(error) = item.set_text(label) {
        eprintln!("Harness-CN: the update menu entry could not be relabelled: {error}");
    }
}

/// Send one command to the sidecar over its stdin.
fn send_command(app: &AppHandle, command: &str) {
    let state = app.state::<Shell>();
    let Ok(mut guard) = state.child.lock() else { return };
    let Some(child) = guard.as_mut() else { return };
    let Some(stdin) = child.stdin.as_mut() else { return };
    if writeln!(stdin, "{{\"command\":\"{command}\"}}").is_err() {
        return;
    }
    let _ = stdin.flush();
}

/// Run one menu action.
fn handle_menu(app: &AppHandle, id: &str) {
    // The QQ console is part of the workspace page, not a shell page: it needs the workspace origin.
    let workspace_port = app.state::<Shell>().port.lock().ok().and_then(|value| *value);
    let app_window = |label: &str, path: &str, title: &str, width: f64, height: f64| {
        if let Some(port) = workspace_port {
            open_window(app, label, format!("{}{path}", origin(port)), title, width, height, false);
        }
    };    let window = |label: &str, path: &str, title: &str, width: f64, height: f64| {
        if shell_port_of(app).is_some() {
            open_window(app, label, format!("{}{path}", shell_origin(app, None)), title, width, height, false);
        }
    };
    match id {
        "restart" => {
            // The single-instance claim belongs to this process, so it has to be given up before
            // the replacement starts; otherwise the new process sees a running shell and leaves.
            platform::release_single_instance();
            match std::env::current_exe().map(|exe| Command::new(exe).spawn()) {
                Ok(Ok(_)) => app.exit(0),
                _ => platform::show_error("Harness-CN", "无法重新启动应用，请手动退出后重新打开。"),
            }
        }
        "servers" => app_window(SERVERS, "/shell/servers.html", "服务器管理", 820.0, 760.0),
        "qq-console" => app_window(QQ_CONSOLE, "/?panel=qq-console", "QQ 群管理", 1024.0, 720.0),
        "logs" => window(LOGS, "/shell/log-viewer.html", "运行日志", 1000.0, 700.0),
        "lan" => window(LAN, "/shell/lan.html", "移动访问", 760.0, 620.0),
        "plugins" => window(PLUGINS, "/shell/plugin-manager.html", "内置插件", 900.0, 620.0),
        "api-key" => window(API_KEY, "/shell/api-key.html", "绑定 DeepSeek 密钥", 560.0, 520.0),
        "author" => window(AUTHOR, "/shell/author.html", "作者信息", 640.0, 660.0),
        "shop" => window(SHOP, "/shell/shop.html", "休闲食品商城", 980.0, 760.0),
        "feedback" => window(FEEDBACK, "/shell/feedback.html", "评价与反馈", 640.0, 620.0),
        "updates" => {
            // A failing automatic check left its reason here. Reporting it before the fresh check
            // runs is what makes the marker on this menu entry actionable: the user sees why the
            // machine stopped being offered releases, not only that it did.
            if let Some(reason) = app.state::<Shell>().update_failure.lock().ok().and_then(|held| held.clone()) {
                platform::show_error("Harness-CN", &format!("上次检查更新失败：\n{reason}"));
            }
            send_command(app, "check-updates");
        }
        "devtools" => {
            if let Some(main) = app.get_webview_window(MAIN) {
                main.open_devtools();
            }
        }
        "quit" => {
            QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
            app.exit(0);
        }
        _ => {}
    }
}

/// Bring the workspace window back from the notification area.
///
/// Closing that window hides it rather than ending the product, so this is the way back. A launch
/// that has not opened the workspace yet has no window here, and doing nothing is the right answer:
/// the workspace opens by itself once it is ready.
fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else { return };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Path of the file that remembers what closing the workspace window does.
///
/// It lives in the installation's data directory beside the other per-machine choices, so a
/// reinstall that keeps `data` keeps the preference too.
fn close_behavior_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("data").join("desktop").join("close-behavior"))
}

/// Read the stored close behaviour. A missing file keeps the default: stay running.
fn load_close_behavior() {
    let Some(path) = close_behavior_path() else { return };
    if let Ok(text) = std::fs::read_to_string(path) {
        KEEP_IN_TRAY.store(text.trim() != "quit", std::sync::atomic::Ordering::SeqCst);
    }
}

/// Store the close behaviour chosen from the tray.
fn save_close_behavior(keep: bool) {
    let Some(path) = close_behavior_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, if keep { "tray" } else { "quit" });
}

/// Caption for the tray entry that flips the close behaviour.
fn keep_entry_label() -> String {
    let keep = KEEP_IN_TRAY.load(std::sync::atomic::Ordering::SeqCst);
    if keep { "关闭窗口后：保留后台 ✔".to_string() } else { "关闭窗口后：退出程序".to_string() }
}

/// Put the product in the notification area.
///
/// The icon is what keeps the shell reachable once its window is closed. Opening the workspace is
/// expensive — the sidecar rebuilds a runtime on the first launch, and a cold plugin tree costs tens
/// of seconds — so a close that ended the process would pay that cost again the next time the user
/// wanted the product. The close hides the window instead and the product keeps running; the middle
/// entry flips that for users who would rather have the memory back, and the last entry is how
/// either of them ends it for good.
fn install_tray(app: &AppHandle) {
    // Rebuilding is how the toggle's own caption changes: the menu is replaced rather than mutated,
    // so there is one code path whether this is the first install or a flip.
    let _ = app.remove_tray_by_id(TRAY_ID);
    let build = || -> tauri::Result<()> {
        let show = MenuItemBuilder::with_id(TRAY_SHOW_ID, "显示主窗口").build(app)?;
        let keep = MenuItemBuilder::with_id(TRAY_KEEP_ID, keep_entry_label()).build(app)?;
        let quit = MenuItemBuilder::with_id(TRAY_QUIT_ID, "退出 Harness-CN").build(app)?;
        let menu = MenuBuilder::new(app).item(&show).item(&keep).item(&quit).build()?;
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip(APP_NAME)
            .menu(&menu)
            // A left click on the icon is the user asking for the product, so it raises the window;
            // the menu belongs on the right button, which is where the platform puts it anyway.
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| {
                let id: &str = event.id().as_ref();
                match id {
                    TRAY_SHOW_ID => show_main_window(app),
                    TRAY_KEEP_ID => {
                        let next = !KEEP_IN_TRAY.load(std::sync::atomic::Ordering::SeqCst);
                        KEEP_IN_TRAY.store(next, std::sync::atomic::Ordering::SeqCst);
                        save_close_behavior(next);
                        install_tray(app);
                    }
                    TRAY_QUIT_ID => {
                QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
                app.exit(0);
            }
                    _ => {}
                }
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main_window(tray.app_handle());
                }
            });
        // The icon is the one the installer already embeds; a build without one still gets a tray
        // entry, only without a glyph.
        if let Some(icon) = app.default_window_icon().cloned() {
            builder = builder.icon(icon);
        }
        builder.build(app)?;
        Ok(())
    };
    if let Err(error) = build() {
        eprintln!("Harness-CN: the tray icon could not be installed: {error}");
    }
}

/// Start the bundled Node sidecar and read its handshake stream.
fn start_sidecar(app: AppHandle) {
    // `bundle.resources` keeps each entry's path, so the trees land under `<resources>/resources`.
    // Everything the sidecar is told about therefore hangs off this one directory, and its own
    // layout — `runtime/node/node.exe`, `runtime/pnpm/bin/pnpm.mjs`, `seed`, `shell` — is the same
    // one the Electron build used.
    let resource_dir = match app.path().resource_dir() {
        Ok(directory) => plain_path(directory.join("resources")),
        Err(_) => {
            platform::show_error("Harness-CN 启动失败", "找不到安装目录。");
            app.exit(1);
            return;
        }
    };
    let log_dir = app.path().app_log_dir().map(plain_path).unwrap_or_else(|_| resource_dir.clone());
    let node = resource_dir.join("runtime").join("node").join("node.exe");
    let script = resource_dir.join("sidecar").join("shell.mjs");
    let version = app.package_info().version.to_string();
    // The sidecar finds the platform uninstaller here. It cannot derive this directory: the only
    // executable path it knows is the Node runtime inside the installation.
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))
        .unwrap_or_else(|| resource_dir.clone());
    eprintln!(
        "Harness-CN: node={} script={} resource_dir={} log_dir={} install_dir={}",
        node.display(),
        script.display(),
        resource_dir.display(),
        log_dir.display(),
        install_dir.display(),
    );
    let spawned = Command::new(&node)
        .arg(&script)
        .arg("--resource-dir")
        .arg(&resource_dir)
        .arg("--version")
        .arg(&version)
        .arg("--log-dir")
        .arg(&log_dir)
        .arg("--install-dir")
        .arg(&install_dir)
        // An installed launch says so, because the sidecar has to tell an inherited `DSH_HOME`
        // (the other desktop product's, often exported machine-wide) from a home this product was
        // pointed at on purpose. Without the mark both products resolve one shared home.
        .env("HARNESS_CN_PACKAGED", "1")
        // `CREATE_NO_WINDOW` because `node.exe` would otherwise allocate the console this shell
        // has no use for. The sidecar is contained in a job immediately after it is spawned —
        // before it can load its own entry point, let alone start the Host — so no separate
        // suspended start is needed to close that window.
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // The sidecar's own diagnostics are the only account of why it refused to start, so they
        // are captured rather than discarded: a shell that exits silently is not a report.
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            platform::show_error(
                "Harness-CN 启动失败",
                &format!("无法启动内置运行时 {}\n{error}", node.display()),
            );
            app.exit(1);
            return;
        }
    };
    // Everything the product starts — the Host, the pnpm transactions, and every process an agent
    // spawns under them — ends with this process, including when this process is killed outright.
    platform::contain_process_tree(&child);
    let Some(stdout) = child.stdout.take() else {
        platform::show_error("Harness-CN 启动失败", "内置运行时没有可读的输出。");
        app.exit(1);
        return;
    };
    if let Some(stderr) = child.stderr.take() {
        let owner = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                eprintln!("Harness-CN sidecar: {line}");
                if let Ok(mut captured) = owner.state::<Shell>().diagnostics.lock() {
                    captured.push_str(&line);
                    captured.push('\n');
                    // Only the end of a crash report is worth showing, and only a bounded amount
                    // of it: the dialog has to stay readable.
                    if captured.len() > 4000 {
                        let trimmed = captured[captured.len() - 4000..].to_string();
                        *captured = trimmed;
                    }
                }
            }
        });
    }
    if let Ok(mut guard) = app.state::<Shell>().child.lock() {
        *guard = Some(child);
    }

    let reader = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Handshake>(&line) else { continue };
            let handle = reader.clone();
            let _ = reader.run_on_main_thread(move || { apply_handshake(&handle, message) });
        }
        // The sidecar owns the Host, the project transaction, and the control surface: once it
        // is gone there is nothing left for this shell to show. A sidecar that died before it
        // ever reported a workspace is a launch failure the user has to be told about; one that
        // ended after that is an ordinary quit.
        let handle = reader.clone();
        let _ = reader.run_on_main_thread(move || {
            let shell = handle.state::<Shell>();
            if shell.ready.load(std::sync::atomic::Ordering::SeqCst) {
                handle.exit(0);
                return;
            }
            let detail = shell.diagnostics.lock().map(|text| text.clone()).unwrap_or_default();
            platform::show_error(
                "Harness-CN 启动失败",
                &format!(
                    "内置运行时未能启动。\n\n{}",
                    if detail.trim().is_empty() { "（没有诊断输出）" } else { detail.trim() },
                ),
            );
            handle.exit(1);
        });
    });
}

/// Stop the sidecar, which stops the Host it owns.
///
/// Exiting is a handshake rather than a kill. The Host is a child of the sidecar and owns the
/// profile directory, the session logs, and every process an agent started; it needs the seconds
/// `DesktopHostProcess::stop` takes to close them. A shell that terminates the sidecar first is
/// what leaves that Host behind, holding the files the next launch has to replace — and a Host
/// still running is a Host whose stale port and half-written session the new one then contends
/// with. So the sidecar is asked to quit and given a bounded window to do it in, and only a
/// sidecar that misses that window is killed. The job object remains the backstop for everything
/// that reaches this path not at all.
fn stop_sidecar(app: &AppHandle) {
    static STOPPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STOPPING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let state = app.state::<Shell>();
    let Ok(mut guard) = state.child.lock() else { return };
    let Some(mut child) = guard.take() else { return };
    let pid = child.id();
    // The same command the menu's own quit path sends: the sidecar stops the Host, closes the
    // control surface, flushes the run log, and exits.
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = writeln!(stdin, "{{\"command\":\"quit\"}}");
        let _ = stdin.flush();
    }
    drop(child.stdin.take());
    let deadline = Instant::now() + GRACEFUL_STOP;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                eprintln!("Harness-CN: the sidecar exited cleanly ({status})");
                return;
            }
            // A failed poll is not evidence the child is alive, so it falls through to the kill
            // rather than spinning out the whole window first.
            Err(_) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    eprintln!("Harness-CN: the sidecar did not stop within {GRACEFUL_STOP:?}; killing the process tree");
    platform::terminate(pid);
    let _ = child.kill();
    let _ = child.wait();
}

fn main() {
    if !platform::claim_single_instance() {
        // A second launch is the user asking for the product, so the instance that owns the claim
        // is asked to raise its window — which it may have hidden rather than closed — before this
        // process leaves. The event is what carries the request; the focus call is the best effort
        // for a release old enough not to know about the event.
        platform::signal_show_event();
        platform::focus_running_instance();
        return;
    }
    // Created before the window loop starts so a second launch always finds the event to signal.
    platform::create_show_event();
    let built = tauri::Builder::default()
        .manage(Shell::default())
        .setup(|app| {
            start_sidecar(app.handle().clone());
            load_close_behavior();
        install_tray(app.handle());
            Ok(())
        })
        .on_menu_event(|app, event| { handle_menu(app, event.id().as_ref()) })
        .build(tauri::generate_context!());
    let app = match built {
        Ok(app) => app,
        Err(error) => {
            platform::show_error("Harness-CN 启动失败", &error.to_string());
            platform::release_single_instance();
            return;
        }
    };
    // The wait runs off the window loop, which has to stay free to pump messages while it blocks.
    let listener = app.handle().clone();
    std::thread::spawn(move || {
        while platform::wait_show_event() {
            let handle = listener.clone();
            let _ = listener.run_on_main_thread(move || show_main_window(&handle));
        }
    });
    app.run(|handle, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            // A window disappearing is not a quit. The splash is destroyed on purpose when the
            // workspace opens, and a launch that is still installing has no window at all; ending
            // the process there would kill the very transaction that was making progress. The
            // launch ends when its own window is closed, or when the sidecar that owns the
            // workspace is gone.
            //
            // Closing the workspace window is a quit now, so that path sets `QUITTING` first: the
            // window is already gone by the time this runs, and without the flag the rule below
            // would read the close as an accident and keep the process alive.
            let sidecar_alive = handle
                .state::<Shell>()
                .child
                .lock()
                .map(|child| child.is_some())
                .unwrap_or(false);
            if !QUITTING.load(std::sync::atomic::Ordering::SeqCst)
                && sidecar_alive
                && handle.get_webview_window(MAIN).is_none()
            {
                eprintln!("Harness-CN: a window closed while the launch is still running; staying up");
                api.prevent_exit();
            }
        }
        RunEvent::Exit => stop_sidecar(handle),
        RunEvent::WindowEvent { ref label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if label == MAIN => {
            // What a close means is the user's choice, remembered in the data directory. Keeping the
            // product running turns the next open into a window show instead of a full plugin-tree
            // start, which is worth tens of seconds; quitting gives the memory back. The tray menu
            // flips it, and the tray keeps either path's exit one click away.
            if KEEP_IN_TRAY.load(std::sync::atomic::Ordering::SeqCst) {
                api.prevent_close();
                if let Some(window) = handle.get_webview_window(MAIN) {
                    let _ = window.hide();
                }
            } else {
                QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
                handle.exit(0);
            }
        }
        _ => {}
    });
}
