#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use rand::{rngs::OsRng, RngCore};
use tauri::{webview::Cookie, AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

mod credentials;
mod diagnostics;
mod process_cleanup;
mod trusted_endpoints;

const LOCAL_SERVICE_PORT: u16 = 47823;
const LOCAL_SERVICE_ORIGIN: &str = "http://127.0.0.1:47823";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);

struct DesktopRuntime {
    child: Mutex<Option<CommandChild>>,
    auth_token: String,
    active_generation: AtomicU64,
    next_generation: AtomicU64,
    starting: AtomicBool,
    shutting_down: AtomicBool,
    automatic_restart_used: AtomicBool,
}

impl DesktopRuntime {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            auth_token: random_token(),
            active_generation: AtomicU64::new(0),
            next_generation: AtomicU64::new(0),
            starting: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            automatic_restart_used: AtomicBool::new(false),
        }
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn fixed_port_available() -> Result<(), String> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, LOCAL_SERVICE_PORT))
        .map(|listener| drop(listener))
        .map_err(|_| {
            format!("端口 {LOCAL_SERVICE_PORT} 已被其他程序占用。请关闭占用该端口的程序后重试。")
        })
}

fn server_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let development = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".next")
            .join("standalone")
            .join("server.js");
        if development.exists() {
            return Ok(development);
        }
    }

    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源：{error}"))?
        .join("server")
        .join("server.js");
    bundled
        .exists()
        .then_some(bundled)
        .ok_or_else(|| "本地服务资源不完整，请重新安装 OpenMAIC Desktop。".to_string())
}

fn health_ready() -> bool {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, LOCAL_SERVICE_PORT).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{LOCAL_SERVICE_PORT}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = [0u8; 32];
    let Ok(read) = stream.read(&mut response) else {
        return false;
    };
    response[..read].starts_with(b"HTTP/1.1 200") || response[..read].starts_with(b"HTTP/1.0 200")
}

fn wait_for_health(app: &AppHandle, generation: u64) -> bool {
    let started = Instant::now();
    while started.elapsed() < HEALTH_TIMEOUT {
        let runtime = app.state::<DesktopRuntime>();
        if runtime.active_generation.load(Ordering::Acquire) != generation {
            return false;
        }
        if health_ready() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn sidecar_environment(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let mut environment = Vec::new();

    #[cfg(debug_assertions)]
    {
        let env_file = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".env.local");
        match dotenvy::from_filename_iter(&env_file) {
            Ok(entries) => {
                let mut invalid = 0usize;
                for entry in entries {
                    match entry {
                        Ok(value) => environment.push(value),
                        Err(_) => invalid += 1,
                    }
                }
                log::info!(
                    "loaded {} development environment values ({} invalid)",
                    environment.len(),
                    invalid
                );
            }
            Err(_) => log::info!("no development .env.local loaded"),
        }
    }

    let runtime = app.state::<DesktopRuntime>();
    let trusted_endpoints = trusted_endpoints::path(app)?;
    environment.extend([
        ("PORT".into(), LOCAL_SERVICE_PORT.to_string()),
        ("HOSTNAME".into(), "127.0.0.1".into()),
        ("DESKTOP_RUNTIME".into(), "1".into()),
        ("DESKTOP_AUTH_TOKEN".into(), runtime.auth_token.clone()),
        ("DESKTOP_SERVICE_ORIGIN".into(), LOCAL_SERVICE_ORIGIN.into()),
        (
            "DESKTOP_TRUSTED_ENDPOINTS_FILE".into(),
            trusted_endpoints.to_string_lossy().into_owned(),
        ),
    ]);
    Ok(environment)
}

fn show_recovery(app: &AppHandle, reason: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let mut url = Url::parse("http://tauri.localhost/recovery.html")
        .expect("the recovery URL is a static application URL");
    url.query_pairs_mut().append_pair("reason", reason);
    if let Err(error) = window.navigate(url) {
        log::error!("could not show recovery mode: {error}");
    }
}

#[tauri::command]
fn enter_recovery_mode(app: AppHandle, reason: String) {
    show_recovery(&app, &reason);
}

fn open_local_service(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不可用。".to_string())?;
    let token = app.state::<DesktopRuntime>().auth_token.clone();
    let cookie = Cookie::build(("openmaic_desktop", token))
        .domain("127.0.0.1")
        .path("/")
        .http_only(true)
        .build();
    window
        .set_cookie(cookie)
        .map_err(|error| format!("无法建立桌面安全会话：{error}"))?;
    window
        .navigate(Url::parse(LOCAL_SERVICE_ORIGIN).expect("the local service URL is static"))
        .map_err(|error| format!("无法打开本地服务：{error}"))
}

fn observe_sidecar(
    app: AppHandle,
    generation: u64,
    mut events: tauri::async_runtime::Receiver<CommandEvent>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    log::debug!("local service stdout event: {} bytes", bytes.len())
                }
                CommandEvent::Stderr(bytes) => {
                    log::debug!("local service stderr event: {} bytes", bytes.len())
                }
                CommandEvent::Error(_) => log::warn!("local service process event error"),
                CommandEvent::Terminated(payload) => {
                    log::warn!(
                        "local service terminated: code={:?}, signal={:?}",
                        payload.code,
                        payload.signal
                    );
                    handle_sidecar_termination(app, generation);
                    break;
                }
                _ => {}
            }
        }
    });
}

fn handle_sidecar_termination(app: AppHandle, generation: u64) {
    let runtime = app.state::<DesktopRuntime>();
    if runtime
        .active_generation
        .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    if let Ok(mut child) = runtime.child.lock() {
        child.take();
    }
    if runtime.shutting_down.load(Ordering::Acquire) || runtime.starting.load(Ordering::Acquire) {
        return;
    }
    if runtime.automatic_restart_used.swap(true, Ordering::AcqRel) {
        show_recovery(
            &app,
            "本地服务已停止，自动恢复未成功。工作区数据尚未被修改。",
        );
        return;
    }

    log::info!("restarting local service once after unexpected termination");
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_secs(1));
        let _ = start_local_service(app, false);
    });
}

fn start_once(app: &AppHandle) -> Result<(), String> {
    fixed_port_available()?;
    let server = server_path(app)?;
    let generation = app
        .state::<DesktopRuntime>()
        .next_generation
        .fetch_add(1, Ordering::AcqRel)
        + 1;
    log::info!("starting local service generation {generation}");

    let node = app
        .shell()
        .sidecar("node")
        .map_err(|error| format!("无法准备本地服务运行时：{error}"))?;
    let (events, child) = node
        .args([server.to_string_lossy().into_owned()])
        .envs(sidecar_environment(app)?)
        .spawn()
        .map_err(|error| format!("无法启动本地服务：{error}"))?;
    process_cleanup::assign_to_job(child.pid());

    {
        let runtime = app.state::<DesktopRuntime>();
        runtime
            .active_generation
            .store(generation, Ordering::Release);
        *runtime
            .child
            .lock()
            .map_err(|_| "本地服务状态不可用。".to_string())? = Some(child);
    }
    observe_sidecar(app.clone(), generation, events);

    if wait_for_health(app, generation) {
        open_local_service(app)?;
        log::info!("local service generation {generation} is ready");
        return Ok(());
    }

    let runtime = app.state::<DesktopRuntime>();
    if runtime
        .active_generation
        .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        if let Ok(mut child) = runtime.child.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
    }
    Err("本地服务未能在限定时间内通过健康检查。".to_string())
}

fn start_local_service(app: AppHandle, allow_automatic_retry: bool) -> Result<(), String> {
    let runtime = app.state::<DesktopRuntime>();
    if runtime.starting.swap(true, Ordering::AcqRel) {
        return Err("本地服务正在启动，请稍候。".to_string());
    }

    let mut result = start_once(&app);
    if result.is_err()
        && allow_automatic_retry
        && !runtime.automatic_restart_used.swap(true, Ordering::AcqRel)
    {
        log::warn!("initial local service start failed; retrying once");
        std::thread::sleep(Duration::from_secs(1));
        result = start_once(&app);
    }
    runtime.starting.store(false, Ordering::Release);

    if let Err(reason) = &result {
        log::error!("local service unavailable: {reason}");
        show_recovery(&app, &format!("{reason} 工作区数据尚未被修改。"));
    }
    result
}

#[tauri::command]
async fn retry_local_service(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start_local_service(app, false))
        .await
        .map_err(|error| format!("无法执行重试：{error}"))?
}

fn build_main_window(app: &tauri::App) -> tauri::Result<()> {
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("OpenMAIC Desktop")
        .inner_size(1280.0, 800.0);

    #[cfg(not(target_os = "macos"))]
    {
        let data_dir = app.path().app_data_dir()?.join("webview");
        std::fs::create_dir_all(&data_dir)?;
        builder = builder.data_directory(data_dir);
    }
    builder.build()?;
    Ok(())
}

fn activate_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            activate_main_window(app)
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([Target::new(TargetKind::LogDir { file_name: None })])
                .max_file_size(2 * 1024 * 1024)
                .rotation_strategy(RotationStrategy::KeepSome(2))
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            retry_local_service,
            enter_recovery_mode,
            credentials::get_provider_credential,
            credentials::set_provider_credential,
            credentials::delete_provider_credential,
            credentials::clear_provider_credentials,
            diagnostics::export_diagnostic_bundle,
            diagnostics::open_log_directory,
            diagnostics::quit_desktop,
            trusted_endpoints::get_trusted_provider_endpoints,
            trusted_endpoints::set_trusted_provider_endpoint,
        ])
        .setup(|app| {
            app.manage(DesktopRuntime::new());
            build_main_window(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _ = start_local_service(handle, true);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building OpenMAIC Desktop");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            if let Some(runtime) = app.try_state::<DesktopRuntime>() {
                runtime.shutting_down.store(true, Ordering::Release);
                runtime.active_generation.store(0, Ordering::Release);
                if let Ok(mut child) = runtime.child.lock() {
                    if let Some(child) = child.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
        _ => {}
    });
}
