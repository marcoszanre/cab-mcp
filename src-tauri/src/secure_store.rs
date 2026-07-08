// ============================================
// Secure Store
// OS-protected credential storage for sensitive values (OAuth access/refresh
// tokens). On Windows this is backed by the Windows Credential Manager, which
// encrypts secrets with DPAPI tied to the current user account.
//
// This replaces storing long-lived OAuth tokens in the WebView2 localStorage
// (plaintext, readable by any script running in the app origin).
// ============================================

use tauri::command;

/// Service name used to namespace all Community Agent Bridge secrets in the OS
/// credential store.
const SERVICE: &str = "community-agent-bridge";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| format!("keyring entry error: {e}"))
}

/// Store a secret value under `key` in the OS credential store.
#[command]
pub fn secure_store_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?
        .set_password(&value)
        .map_err(|e| format!("failed to store secret: {e}"))
}

/// Retrieve a secret value for `key`. Returns `None` if no entry exists.
#[command]
pub fn secure_store_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("failed to read secret: {e}")),
    }
}

/// Delete the secret stored under `key`. Succeeds even if no entry exists.
#[command]
pub fn secure_store_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to delete secret: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exercises a full round-trip against the real OS credential store. Ignored
    // by default because it has side effects and requires an interactive user
    // credential store (not always available in CI).
    #[test]
    #[ignore]
    fn round_trip() {
        let key = "test-secure-store-roundtrip";
        secure_store_set(key.into(), "s3cr3t".into()).unwrap();
        assert_eq!(
            secure_store_get(key.into()).unwrap().as_deref(),
            Some("s3cr3t")
        );
        secure_store_delete(key.into()).unwrap();
        assert_eq!(secure_store_get(key.into()).unwrap(), None);
    }
}
