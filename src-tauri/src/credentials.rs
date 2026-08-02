use std::{collections::BTreeSet, fs, sync::Mutex};

use tauri::Manager;

const SERVICE: &str = "com.openmaic.desktop.providers";
const INDEX_FILE: &str = "provider-credential-index.json";
static INDEX_LOCK: Mutex<()> = Mutex::new(());

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
        return Err("invalid credential identifier".to_string());
    }
    Ok(())
}

fn index_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(INDEX_FILE))
        .map_err(|error| format!("could not resolve credential index directory: {error}"))
}

fn read_index(app: &tauri::AppHandle) -> Result<BTreeSet<String>, String> {
    let path = index_path(app)?;
    if !path.exists() {
        return Ok(BTreeSet::new());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("could not read credential index: {error}"))?;
    let ids: BTreeSet<String> = serde_json::from_slice(&bytes)
        .map_err(|error| format!("credential index is invalid: {error}"))?;
    for id in &ids {
        validate_id(id)?;
    }
    Ok(ids)
}

fn write_index(app: &tauri::AppHandle, ids: &BTreeSet<String>) -> Result<(), String> {
    let path = index_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("could not create credential index directory: {error}"))?;
    }
    let bytes = serde_json::to_vec(ids)
        .map_err(|error| format!("could not encode credential index: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("could not save credential index: {error}"))
}

#[cfg(windows)]
fn entry(id: &str) -> Result<keyring::Entry, String> {
    validate_id(id)?;
    keyring::Entry::new(SERVICE, id)
        .map_err(|error| format!("credential store unavailable: {error}"))
}

#[cfg(windows)]
fn read_password(id: &str) -> Result<Option<String>, String> {
    match entry(id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("could not read protected credential: {error}")),
    }
}

#[cfg(windows)]
fn write_password(id: &str, value: &str) -> Result<(), String> {
    entry(id)?
        .set_password(value)
        .map_err(|error| format!("could not protect credential: {error}"))
}

#[cfg(windows)]
fn remove_password(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("could not delete protected credential: {error}")),
    }
}

#[cfg(windows)]
fn restore_passwords(credentials: &[(String, String)]) -> Result<(), String> {
    let mut failures = Vec::new();
    for (id, value) in credentials {
        if let Err(error) = write_password(id, value) {
            failures.push(format!("{id}: {error}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "credential rollback failed for {}",
            failures.join(", ")
        ))
    }
}

#[tauri::command]
pub fn get_provider_credential(
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let _guard = INDEX_LOCK
            .lock()
            .map_err(|_| "credential index lock is unavailable".to_string())?;
        let value = read_password(&id)?;
        if value.is_some() {
            let mut ids = read_index(&app)?;
            if ids.insert(id) {
                write_index(&app, &ids)?;
            }
        }
        Ok(value)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id);
        Err("protected credentials are supported only on Windows".to_string())
    }
}

#[tauri::command]
pub fn set_provider_credential(
    app: tauri::AppHandle,
    id: String,
    value: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        if value.is_empty() {
            return delete_provider_credential(app, id);
        }
        validate_id(&id)?;
        let _guard = INDEX_LOCK
            .lock()
            .map_err(|_| "credential index lock is unavailable".to_string())?;
        let previous_ids = read_index(&app)?;
        let mut next_ids = previous_ids.clone();
        next_ids.insert(id.clone());
        write_index(&app, &next_ids)?;
        if let Err(error) = write_password(&id, &value) {
            return match write_index(&app, &previous_ids) {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(format!(
                    "{error}; credential index rollback also failed: {rollback_error}"
                )),
            };
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id, value);
        Err("protected credentials are supported only on Windows".to_string())
    }
}

#[tauri::command]
pub fn delete_provider_credential(app: tauri::AppHandle, id: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        validate_id(&id)?;
        let _guard = INDEX_LOCK
            .lock()
            .map_err(|_| "credential index lock is unavailable".to_string())?;
        let previous = read_password(&id)?;
        let previous_ids = read_index(&app)?;
        remove_password(&id)?;
        let mut next_ids = previous_ids.clone();
        next_ids.remove(&id);
        if let Err(error) = write_index(&app, &next_ids) {
            let rollback = match previous {
                Some(value) => write_password(&id, &value),
                None => Ok(()),
            };
            let index_rollback = write_index(&app, &previous_ids);
            return match (rollback, index_rollback) {
                (Ok(()), Ok(())) => Err(error),
                (credential_result, index_result) => Err(format!(
                    "{error}; rollback failed: credential={:?}, index={:?}",
                    credential_result.err(),
                    index_result.err()
                )),
            };
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id);
        Err("protected credentials are supported only on Windows".to_string())
    }
}

/** Delete every app-owned provider secret, rolling all values back on failure. */
#[tauri::command]
pub fn clear_provider_credentials(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _guard = INDEX_LOCK
            .lock()
            .map_err(|_| "credential index lock is unavailable".to_string())?;
        let ids = read_index(&app)?;
        let mut credentials = Vec::new();
        for id in &ids {
            if let Some(value) = read_password(id)? {
                credentials.push((id.clone(), value));
            }
        }

        for id in &ids {
            if let Err(error) = remove_password(id) {
                return match restore_passwords(&credentials) {
                    Ok(()) => Err(error),
                    Err(rollback_error) => Err(format!("{error}; {rollback_error}")),
                };
            }
        }
        if let Err(error) = write_index(&app, &BTreeSet::new()) {
            let credential_rollback = restore_passwords(&credentials);
            let index_rollback = write_index(&app, &ids);
            return match (credential_rollback, index_rollback) {
                (Ok(()), Ok(())) => Err(error),
                (credential_result, index_result) => Err(format!(
                    "{error}; rollback failed: credential={:?}, index={:?}",
                    credential_result.err(),
                    index_result.err()
                )),
            };
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("protected credentials are supported only on Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::validate_id;

    #[test]
    fn rejects_unsafe_credential_identifiers() {
        assert!(validate_id("").is_err());
        assert!(validate_id("provider\nkey").is_err());
        assert!(validate_id("providers/openai/apiKey").is_ok());
    }
}
