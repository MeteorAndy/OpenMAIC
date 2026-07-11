#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;

mod process_cleanup;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Fixed port for the node sidecar. The WebView origin is `http://127.0.0.1:<port>`,
/// and IndexedDB / localStorage / zustand-persist stores are all partitioned by origin
/// (scheme+host+port). A random port orphaned every user's data on each restart — the
/// single biggest data-loss bug in the desktop port. Fixed port = stable origin.
/// Uncommon value to dodge dev servers (3456) and common local tools.
const SIDEKICK_PORT: u16 = 47823;

/// Fixed WKWebsiteDataStore identifier (macOS 14+) — gives the app a named,
/// persistent store isolated from Safari's ITP. Must be stable across launches.
/// Spells "OpenMAICDesk\0\x01\0\x01". No-op on non-macOS builds (cfg-gated).
#[cfg(target_os = "macos")]
const MACOS_DATA_STORE_ID: [u8; 16] = [
    0x4F, 0x70, 0x65, 0x6E, 0x4D, 0x41, 0x49, 0x43, 0x44, 0x65, 0x73, 0x6B, 0x00, 0x01, 0x00, 0x01,
];

/// Confirm the fixed port is free, then release it so the sidecar can bind it. On
/// failure, exit — NEVER fall back to a random port (that reintroduces the
/// origin-orphaning bug). A second running instance is the usual cause.
fn bind_fixed_port() -> u16 {
    match TcpListener::bind(("127.0.0.1", SIDEKICK_PORT)) {
        Ok(listener) => {
            drop(listener);
            SIDEKICK_PORT
        }
        Err(e) => {
            log::error!(
                "Port {} unavailable ({}). Another instance may be running. Exiting.",
                SIDEKICK_PORT,
                e
            );
            std::process::exit(1);
        }
    }
}

/// Resolve the bundled server.js path (resources/server/server.js).
fn server_path(app: &tauri::App) -> std::path::PathBuf {
    let resource_dir = app.path().resource_dir().expect("resource_dir failed");
    // In dev, resources resolve under src-tauri; in bundle, under the app resource dir.
    let candidate = resource_dir.join("server").join("server.js");
    if candidate.exists() {
        return candidate;
    }
    // dev fallback
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("server")
        .join("server.js")
}

/// Poll the health endpoint until it responds or timeout.
fn wait_for_health(port: u16, timeout: Duration) -> bool {
    let url = format!("http://127.0.0.1:{}/api/access-code/status", port);
    let start = Instant::now();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(1000))
        .build()
        .unwrap();
    while start.elapsed() < timeout {
        if client
            .get(&url)
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false)
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Wrapper so Task 7 can take() the child on exit.
/// Mutex is required: Tauri State must be Send+Sync, CommandChild is not Sync.
pub struct MutexChild(pub std::sync::Mutex<Option<CommandChild>>);

fn main() {
    env_logger::init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = bind_fixed_port();
            let server_js = server_path(app);
            log::info!("spawning node sidecar: {:?} on port {}", server_js, port);

            let node = app
                .shell()
                .sidecar("node")
                .expect("node sidecar not configured in externalBin");

            let (_rx, child): (tauri::async_runtime::Receiver<_>, CommandChild) = node
                .args([server_js.to_string_lossy().to_string()])
                .envs([
                    ("PORT".to_string(), port.to_string()),
                    ("HOSTNAME".to_string(), "127.0.0.1".to_string()),
                ])
                .spawn()
                .expect("failed to spawn node sidecar");

            // Wait for the server to come up before opening the window.
            if !wait_for_health(port, Duration::from_secs(30)) {
                log::error!("node sidecar did not become healthy within 30s");
            }

            // Tier 2: assign node to a Windows Job Object so a force-killed parent
            // still gets the child reaped by the kernel. pid() borrows, safe before move.
            process_cleanup::assign_to_job(child.pid());

            // Store the child so ExitRequested (Task 7) can kill it.
            app.manage(MutexChild(std::sync::Mutex::new(Some(child))));

            // Pin WebView data to a stable, app-owned location so IndexedDB /
            // localStorage survive restarts and browser data-clearing. Win/Linux
            // use data_directory; macOS 14+ uses a named WKWebsiteDataStore
            // (data_store_identifier) to opt out of Safari's ITP 7-day eviction.
            // This is the real webview URL. tauri.conf.json's `build.devUrl` is
            // informational only (never consulted here) but kept because some
            // Tauri dev tooling expects the field.
            let mut builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(format!("http://127.0.0.1:{}", port).parse().unwrap()),
            )
            .title("OpenMAIC Desktop")
            .inner_size(1280.0, 800.0);

            #[cfg(not(target_os = "macos"))]
            {
                let data_dir = app
                    .path()
                    .app_data_dir()
                    .expect("app_data_dir resolved")
                    .join("webview");
                std::fs::create_dir_all(&data_dir).ok();
                builder = builder.data_directory(data_dir);
            }
            #[cfg(target_os = "macos")]
            {
                builder = builder.data_store_identifier(MACOS_DATA_STORE_ID);
            }

            builder.build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building tauri app");

    app.run(|app_handle: &tauri::AppHandle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<MutexChild>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
        _ => {}
    });
}
