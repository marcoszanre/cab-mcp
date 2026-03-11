// ============================================
// Config File Module
// Single JSON config file with ${ENV_VAR} substitution.
// Replaces the old DPAPI/keyring secret store.
// ============================================

use regex::Regex;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use uuid::Uuid;

const CONFIG_FILE_NAME: &str = "cab-config.json";

/// Load the config file, resolve `${VAR}` references, and return the resolved JSON.
/// If the file does not exist, returns an empty object `{}`.
pub fn load_config_file(app: &AppHandle) -> Result<Value, String> {
    let path = config_file_path(app)?;
    let raw = read_config_file(&path)?;
    let env_block = extract_env_block(&raw);
    Ok(resolve_env_vars(&raw, &env_block))
}

/// Load the raw (unresolved) config file contents for export.
pub fn load_raw_config_file(app: &AppHandle) -> Result<Value, String> {
    let path = config_file_path(app)?;
    read_config_file(&path)
}

/// Save a raw (unresolved) config document to the config file atomically.
pub fn save_config_file(app: &AppHandle, config: &Value) -> Result<(), String> {
    let path = config_file_path(app)?;
    let serialized = serde_json::to_vec_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    write_atomic(&path, &serialized)
}

/// Return the absolute path to the config file.
pub fn get_config_file_path(app: &AppHandle) -> Result<String, String> {
    let path = config_file_path(app)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Import a config document (validate + write).
pub fn import_config_file(app: &AppHandle, config: &Value) -> Result<(), String> {
    if !config.is_object() {
        return Err("Config must be a JSON object.".to_string());
    }
    save_config_file(app, config)
}

// ────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────

fn config_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path_resolver()
        .app_data_dir()
        .ok_or_else(|| "Failed to resolve the app data directory.".to_string())?;
    Ok(app_data_dir.join(CONFIG_FILE_NAME))
}

fn read_config_file(path: &Path) -> Result<Value, String> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Object(Default::default())),
        Err(e) => return Err(format!("Failed to read config file '{}': {}", path.display(), e)),
    };

    serde_json::from_slice(&bytes)
        .map_err(|e| format!("Failed to parse config file '{}': {}", path.display(), e))
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!("Failed to create config directory '{}': {}", parent.display(), e)
        })?;
    }

    let temp_path = path.with_file_name(format!(
        "{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("cab-config"),
        Uuid::new_v4()
    ));

    let write_result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&temp_path)
            .map_err(|e| format!("Failed to create temp config file: {}", e))?;
        file.write_all(contents)
            .map_err(|e| format!("Failed to write temp config file: {}", e))?;
        file.flush()
            .map_err(|e| format!("Failed to flush temp config file: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync temp config file: {}", e))?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(e);
    }

    if let Err(e) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "Failed to move config file into place '{}' → '{}': {}",
            temp_path.display(),
            path.display(),
            e
        ));
    }

    Ok(())
}

/// Extract the `env` block from a config document as a flat key→value map.
fn extract_env_block(config: &Value) -> HashMap<String, String> {
    let mut result = HashMap::new();

    if let Some(env_obj) = config.get("env").and_then(|v| v.as_object()) {
        for (key, value) in env_obj {
            if key == "vars" {
                // Nested `vars` block (OpenClaw compat)
                if let Some(vars_obj) = value.as_object() {
                    for (k, v) in vars_obj {
                        if let Some(s) = v.as_str() {
                            result.insert(k.clone(), s.to_string());
                        }
                    }
                }
            } else if let Some(s) = value.as_str() {
                result.insert(key.clone(), s.to_string());
            }
        }
    }

    result
}

/// Recursively resolve `${VAR_NAME}` and `$env:VAR_NAME` references in all string values.
/// - Process env takes priority over the `env` block (never override).
fn resolve_env_vars(value: &Value, env_block: &HashMap<String, String>) -> Value {
    match value {
        Value::String(s) => Value::String(substitute_env(s, env_block)),
        Value::Array(arr) => Value::Array(arr.iter().map(|v| resolve_env_vars(v, env_block)).collect()),
        Value::Object(obj) => {
            let resolved: serde_json::Map<String, Value> = obj
                .iter()
                .map(|(k, v)| {
                    // Don't resolve inside the `env` block itself
                    if k == "env" {
                        (k.clone(), v.clone())
                    } else {
                        (k.clone(), resolve_env_vars(v, env_block))
                    }
                })
                .collect();
            Value::Object(resolved)
        }
        other => other.clone(),
    }
}

/// Replace all `${VAR_NAME}` and `$env:VAR_NAME` occurrences in a string.
fn substitute_env(input: &str, env_block: &HashMap<String, String>) -> String {
    let re = Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)").unwrap();
    re.replace_all(input, |caps: &regex::Captures| {
        let var_name = caps.get(1).or_else(|| caps.get(2)).unwrap().as_str();
        // Process env first, then env block, then empty string
        std::env::var(var_name)
            .ok()
            .or_else(|| env_block.get(var_name).cloned())
            .unwrap_or_default()
    })
    .into_owned()
}

// ────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_config_path() -> PathBuf {
        std::env::temp_dir().join(format!("cab-config-test-{}.json", Uuid::new_v4()))
    }

    #[test]
    fn round_trips_config_file() {
        let path = temp_config_path();
        let config = json!({
            "version": 1,
            "config": {
                "endpoint": "https://example.com",
                "accessKey": "my-secret"
            }
        });

        let serialized = serde_json::to_vec_pretty(&config).unwrap();
        write_atomic(&path, &serialized).expect("write");
        let loaded = read_config_file(&path).expect("read");

        assert_eq!(loaded, config);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn resolves_env_vars_from_env_block() {
        let config = json!({
            "env": {
                "MY_KEY": "resolved-value"
            },
            "config": {
                "apiKey": "${MY_KEY}",
                "literal": "no-substitution"
            }
        });

        let env_block = extract_env_block(&config);
        let resolved = resolve_env_vars(&config, &env_block);

        assert_eq!(resolved["config"]["apiKey"], "resolved-value");
        assert_eq!(resolved["config"]["literal"], "no-substitution");
        // env block itself is NOT resolved
        assert_eq!(resolved["env"]["MY_KEY"], "MY_KEY".replace("MY_KEY", "resolved-value"));
    }

    #[test]
    fn process_env_overrides_env_block() {
        std::env::set_var("CAB_TEST_OVERRIDE", "from-process");

        let config = json!({
            "env": {
                "CAB_TEST_OVERRIDE": "from-config"
            },
            "config": {
                "value": "${CAB_TEST_OVERRIDE}"
            }
        });

        let env_block = extract_env_block(&config);
        let resolved = resolve_env_vars(&config, &env_block);

        assert_eq!(resolved["config"]["value"], "from-process");
        std::env::remove_var("CAB_TEST_OVERRIDE");
    }

    #[test]
    fn missing_var_resolves_to_empty_string() {
        let config = json!({
            "config": {
                "value": "${DEFINITELY_MISSING_VAR_12345}"
            }
        });

        let env_block = HashMap::new();
        let resolved = resolve_env_vars(&config, &env_block);

        assert_eq!(resolved["config"]["value"], "");
    }

    #[test]
    fn empty_file_returns_empty_object() {
        let path = temp_config_path();
        let loaded = read_config_file(&path).expect("read non-existent");
        assert_eq!(loaded, json!({}));
    }

    #[test]
    fn nested_vars_block_supported() {
        let config = json!({
            "env": {
                "TOP_LEVEL": "top",
                "vars": {
                    "NESTED": "nested-val"
                }
            },
            "config": {
                "a": "${TOP_LEVEL}",
                "b": "${NESTED}"
            }
        });

        let env_block = extract_env_block(&config);
        let resolved = resolve_env_vars(&config, &env_block);

        assert_eq!(resolved["config"]["a"], "top");
        assert_eq!(resolved["config"]["b"], "nested-val");
    }

    #[test]
    fn resolves_powershell_env_syntax_from_env_block() {
        let config = json!({
            "env": {
                "MY_KEY": "ps-resolved"
            },
            "config": {
                "apiKey": "$env:MY_KEY",
                "literal": "no-substitution"
            }
        });

        let env_block = extract_env_block(&config);
        let resolved = resolve_env_vars(&config, &env_block);

        assert_eq!(resolved["config"]["apiKey"], "ps-resolved");
        assert_eq!(resolved["config"]["literal"], "no-substitution");
    }

    #[test]
    fn resolves_powershell_env_syntax_from_process_env() {
        std::env::set_var("CAB_TEST_PS_VAR", "from-process-ps");

        let config = json!({
            "config": {
                "value": "$env:CAB_TEST_PS_VAR"
            }
        });

        let env_block = HashMap::new();
        let resolved = resolve_env_vars(&config, &env_block);

        assert_eq!(resolved["config"]["value"], "from-process-ps");
        std::env::remove_var("CAB_TEST_PS_VAR");
    }

    #[test]
    fn mixed_syntax_both_resolve() {
        let config = json!({
            "env": {
                "KEY_A": "val-a",
                "KEY_B": "val-b"
            },
            "config": {
                "a": "${KEY_A}",
                "b": "$env:KEY_B"
            }
        });

        let env_block = extract_env_block(&config);
        let resolved = resolve_env_vars(&config, &env_block);

        assert_eq!(resolved["config"]["a"], "val-a");
        assert_eq!(resolved["config"]["b"], "val-b");
    }

    #[test]
    fn missing_powershell_var_resolves_to_empty_string() {
        let config = json!({
            "config": {
                "value": "$env:DEFINITELY_MISSING_PS_VAR_12345"
            }
        });

        let env_block = HashMap::new();
        let resolved = resolve_env_vars(&config, &env_block);

        assert_eq!(resolved["config"]["value"], "");
    }
}
