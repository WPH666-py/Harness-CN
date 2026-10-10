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
/// Window label of the run-log viewer.
const LOGS: &str = "logs";
/// Window label of the release prompt.
const UPDATE: &str = "update";

/// Owned children, the port the sidecar published, and the account of a failed launch.
#[derive(Default)]
struct Shell {
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
    /// Whether the sidecar ever reported a usable workspace.
    ready: std::sync::atomic::AtomicBool,
    /// Tail of the sidecar's own diagnostics, shown when it dies before that.
    diagnostics: Mutex<String>,
}

/// One line the sidecar wrote to its stdout.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Handshake {
    /// The control surface is listening, so the progress window can be shown.
    Listen { port: u16 },
    /// The launch advanced; the progress window reads the same value from the control surface.
    Status {
        #[allow(dead_code)]
        status: serde_json::Value,
    },
    /// The workspace is ready to be shown.
    Ready {
        port: u16,
        #[serde(rename = "needsApiKey")]
        needs_api_key: bool,
    },
    /// The release channel changed state.
    Update { state: UpdateState },
    /// A fact the user has to be told about, raised by a menu action.
    Message { title: String, body: String },
    /// The launch failed and there is no window that could report it.
    Fatal { message: String },
}

/// The subset of the release-channel state the shell acts on.
#[derive(Deserialize)]
struct UpdateState {
    phase: String,
    #[serde(default)]
    version: Option<String>,
}

fn origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
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
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(560.0, 420.0)
        .resizable(resizable)
        .center()
        .visible(true)
        .on_navigation(|target| target.host_str() == Some("127.0.0.1"))
        .build()
        .ok()
}

/// Apply one fact the sidecar reported.
fn apply_handshake(app: &AppHandle, message: Handshake) {
    match message {
        Handshake::Listen { port } => {
            if let Ok(mut current) = app.state::<Shell>().port.lock() {
                *current = Some(port);
            }
            open_window(
                app,
                SPLASH,
                format!("{}/shell/startup.html", origin(port)),
                "Harness-CN 正在启动",
                520.0,
                560.0,
                false,
            );
        }
        Handshake::Status { .. } => {}
        Handshake::Ready { port, needs_api_key } => {
            if let Ok(mut current) = app.state::<Shell>().port.lock() {
                *current = Some(port);
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
                    format!("{}/shell/api-key.html", origin(port)),
                    "绑定 DeepSeek 密钥",
                    560.0,
                    520.0,
                    false,
                );
            }
        }
        Handshake::Update { state } => {
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
            let port = app.state::<Shell>().port.lock().ok().and_then(|value| *value);
            let Some(port) = port else { return };
            let version = state.version.unwrap_or_default();
            open_window(
                app,
                UPDATE,
                format!("{}/shell/update.html?v={version}", origin(port)),
                "发现新版本",
                620.0,
                620.0,
                false,
            );
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
            .item(&MenuItemBuilder::with_id("logs", "运行日志").build(app)?)
            .item(&MenuItemBuilder::with_id("plugins", "插件管理").build(app)?)
            .item(&MenuItemBuilder::with_id("updates", "检查更新").build(app)?)
            .item(&MenuItemBuilder::with_id("api-key", "API 密钥").build(app)?)
            .item(&MenuItemBuilder::with_id("devtools", "开发者工具").build(app)?)
            .item(&MenuItemBuilder::with_id("quit", "退出").build(app)?)
            .build()?;
        app.set_menu(menu)?;
        Ok(())
    };
    if let Err(error) = build() {
        eprintln!("Harness-CN: the menu bar could not be installed: {error}");
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
    let port = app.state::<Shell>().port.lock().ok().and_then(|value| *value);
    let window = |label: &str, path: &str, title: &str, width: f64, height: f64| {
        if let Some(port) = port {
            open_window(app, label, format!("{}{path}", origin(port)), title, width, height, false);
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
        "logs" => window(LOGS, "/shell/log-viewer.html", "运行日志", 1000.0, 700.0),
        "plugins" => window(PLUGINS, "/shell/plugin-manager.html", "插件管理", 900.0, 620.0),
        "api-key" => window(API_KEY, "/shell/api-key.html", "绑定 DeepSeek 密钥", 560.0, 520.0),
        "updates" => send_command(app, "check-updates"),
        "devtools" => {
            if let Some(main) = app.get_webview_window(MAIN) {
                main.open_devtools();
            }
        }
        "quit" => app.exit(0),
        _ => {}
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
        platform::focus_running_instance();
        return;
    }
    let built = tauri::Builder::default()
        .manage(Shell::default())
        .setup(|app| {
            start_sidecar(app.handle().clone());
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
    app.run(|handle, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            // A window disappearing is not a quit. The splash is destroyed on purpose when the
            // workspace opens, and a launch that is still installing has no window at all; ending
            // the process there would kill the very transaction that was making progress. The
            // launch ends when its own window is closed, or when the sidecar that owns the
            // workspace is gone.
            let sidecar_alive = handle
                .state::<Shell>()
                .child
                .lock()
                .map(|child| child.is_some())
                .unwrap_or(false);
            if sidecar_alive && handle.get_webview_window(MAIN).is_none() {
                eprintln!("Harness-CN: a window closed while the launch is still running; staying up");
                api.prevent_exit();
            }
        }
        RunEvent::Exit => stop_sidecar(handle),
        RunEvent::WindowEvent { ref label, event: tauri::WindowEvent::Destroyed, .. } if label == MAIN => {
            handle.exit(0);
        }
        _ => {}
    });
}
