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
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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

/// Owned children and the port the sidecar published.
#[derive(Default)]
struct Shell {
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
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
            if state.phase != "available" {
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
                540.0,
                380.0,
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
        Ok(directory) => directory.join("resources"),
        Err(_) => {
            platform::show_error("Harness-CN 启动失败", "找不到安装目录。");
            app.exit(1);
            return;
        }
    };
    let log_dir = app.path().app_log_dir().unwrap_or_else(|_| resource_dir.clone());
    let node = resource_dir.join("runtime").join("node").join("node.exe");
    let script = resource_dir.join("sidecar").join("shell.mjs");
    let version = app.package_info().version.to_string();
    let spawned = Command::new(&node)
        .arg(&script)
        .arg("--resource-dir")
        .arg(&resource_dir)
        .arg("--version")
        .arg(&version)
        .arg("--log-dir")
        .arg(&log_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
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
    let Some(stdout) = child.stdout.take() else {
        platform::show_error("Harness-CN 启动失败", "内置运行时没有可读的输出。");
        app.exit(1);
        return;
    };
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
        // is gone there is nothing left for this shell to show, so it goes with it.
        let handle = reader.clone();
        let _ = reader.run_on_main_thread(move || { handle.exit(0) });
    });
}

/// Stop the sidecar, which stops the Host it owns.
fn stop_sidecar(app: &AppHandle) {
    let state = app.state::<Shell>();
    let Ok(mut guard) = state.child.lock() else { return };
    if let Some(mut child) = guard.take() {
        // Dropping the stdin pipe is what the sidecar watches for; the kill is the backstop.
        drop(child.stdin.take());
        let _ = child.kill();
        let _ = child.wait();
    }
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
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_sidecar(handle);
        }
    });
}
