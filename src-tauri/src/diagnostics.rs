use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::Manager;

const MAX_LOG_BYTES: usize = 4 * 1024 * 1024;

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub fn redact(value: &str) -> String {
    let home = std::env::var("USERPROFILE").ok();
    value
        .lines()
        .map(|line| {
            let lowered = line.to_ascii_lowercase();
            if [
                "authorization",
                "bearer ",
                "apikey",
                "api_key",
                "accesskeysecret",
                "password",
                "desktop_auth_token",
            ]
            .iter()
            .any(|marker| lowered.contains(marker))
            {
                return "[redacted sensitive log line]".to_string();
            }
            let mut safe = line.chars().take(4096).collect::<String>();
            if let Some(home) = &home {
                safe = safe.replace(home, "%USERPROFILE%");
            }
            safe
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn log_files(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("could not resolve log directory: {error}"))?;
    let mut files = fs::read_dir(dir)
        .map_err(|error| format!("could not read log directory: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            path.is_file().then_some(path)
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH)
    });
    files.reverse();
    Ok(files)
}

fn diagnostic_text(app: &tauri::AppHandle) -> Result<String, String> {
    let mut output = format!(
        "OpenMAIC Desktop Diagnostic Bundle\ncreated_unix={}\nversion={}\nos={}\narch={}\ntelemetry=disabled\n\n",
        unix_timestamp(),
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH,
    );
    let mut remaining = MAX_LOG_BYTES;
    for path in log_files(app)? {
        if remaining == 0 {
            break;
        }
        let bytes = fs::read(&path).map_err(|error| format!("could not read log file: {error}"))?;
        let start = bytes.len().saturating_sub(remaining);
        let selected = &bytes[start..];
        remaining = remaining.saturating_sub(selected.len());
        output.push_str(&format!(
            "\n===== {} =====\n{}\n",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("desktop.log"),
            redact(&String::from_utf8_lossy(selected))
        ));
    }
    Ok(output)
}

#[tauri::command]
pub async fn export_diagnostic_bundle(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let suggested = format!("openmaic-diagnostics-{}.txt", unix_timestamp());
    let destination = rfd::AsyncFileDialog::new()
        .set_title("导出 OpenMAIC Desktop 诊断信息")
        .set_file_name(&suggested)
        .add_filter("Text", &["txt"])
        .save_file()
        .await;
    let Some(destination) = destination else {
        return Ok(None);
    };
    let path = destination.path().to_path_buf();
    fs::write(&path, diagnostic_text(&app)?)
        .map_err(|error| format!("could not write diagnostic bundle: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn open_log_directory(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("could not resolve log directory: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("could not create log directory: {error}"))?;
    std::process::Command::new("explorer.exe")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not open log directory: {error}"))
}

#[tauri::command]
pub fn quit_desktop(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn removes_sensitive_log_lines() {
        let output = redact("ready\nAuthorization: Bearer secret\napiKey=secret");
        assert_eq!(
            output,
            "ready\n[redacted sensitive log line]\n[redacted sensitive log line]"
        );
    }
}
