use std::{fs, net::IpAddr, path::PathBuf, str::FromStr};

use tauri::Manager;

const FILE_NAME: &str = "trusted-provider-endpoints.json";

pub fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|error| format!("could not resolve application data directory: {error}"))
}

fn normalize(endpoint: &str) -> Result<String, String> {
    if endpoint.len() > 2048 {
        return Err("provider endpoint is too long".to_string());
    }
    let url = tauri::Url::parse(endpoint).map_err(|_| "invalid provider endpoint".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("provider endpoint must be an HTTP(S) URL without embedded credentials".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "provider endpoint has no host".to_string())?;
    let normalized_host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if [
        "localhost",
        "metadata",
        "metadata.google.internal",
        "instance-data",
    ]
    .contains(&normalized_host.as_str())
    {
        return Err(
            "loopback and infrastructure endpoints cannot be added to the LAN allowlist".into(),
        );
    }
    if let Ok(address) = IpAddr::from_str(&normalized_host) {
        let private_lan = match address {
            IpAddr::V4(address) => address.is_private(),
            IpAddr::V6(address) => address.is_unique_local(),
        };
        if !private_lan {
            return Err("only private LAN endpoints can be added to this allowlist".into());
        }
    }
    let default_port = match url.scheme() {
        "http" => 80,
        _ => 443,
    };
    let port = url.port().unwrap_or(default_port);
    let origin_host = if normalized_host.contains(':') {
        format!("[{normalized_host}]")
    } else {
        normalized_host
    };
    Ok(format!("{}://{}:{}", url.scheme(), origin_host, port))
}

fn read(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let file = path(app)?;
    if !file.exists() {
        return Ok(Vec::new());
    }
    let bytes =
        fs::read(&file).map_err(|error| format!("could not read endpoint allowlist: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("endpoint allowlist is invalid: {error}"))
}

fn write(app: &tauri::AppHandle, endpoints: &[String]) -> Result<(), String> {
    let file = path(app)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("could not create application data directory: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(endpoints)
        .map_err(|error| format!("could not encode endpoint allowlist: {error}"))?;
    fs::write(file, bytes).map_err(|error| format!("could not save endpoint allowlist: {error}"))
}

#[tauri::command]
pub fn get_trusted_provider_endpoints(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    read(&app)
}

#[tauri::command]
pub fn set_trusted_provider_endpoint(
    app: tauri::AppHandle,
    endpoint: String,
    trusted: bool,
) -> Result<Vec<String>, String> {
    let endpoint = normalize(&endpoint)?;
    let mut endpoints = read(&app)?;
    endpoints.retain(|existing| existing != &endpoint);
    if trusted {
        if endpoints.len() >= 256 {
            return Err("too many trusted provider endpoints".into());
        }
        endpoints.push(endpoint);
        endpoints.sort();
    }
    write(&app, &endpoints)?;
    Ok(endpoints)
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn normalizes_endpoint_origins() {
        assert_eq!(
            normalize("http://192.168.1.20:11434/v1").unwrap(),
            "http://192.168.1.20:11434"
        );
        assert_eq!(
            normalize("https://EXAMPLE.com/path").unwrap(),
            "https://example.com:443"
        );
        assert!(normalize("http://user:pass@example.com").is_err());
        assert!(normalize("file:///tmp/provider").is_err());
        assert!(normalize("http://127.0.0.1:11434").is_err());
        assert!(normalize("http://169.254.169.254").is_err());
        assert!(normalize("https://8.8.8.8").is_err());
        assert!(normalize("http://[fd00::20]:11434").is_ok());
    }
}
