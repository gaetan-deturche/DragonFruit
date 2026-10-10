//! Security for the automation (MCP) bridge.
//!
//! The webview's automation bridge (src/automation/useAutomationBridge.ts) dials
//! OUT to a local WebSocket hosted by the DragonFruit MCP server
//! (tools/dragonfruit-mcp). Anything able to listen on that loopback port could
//! otherwise send commands to the app (load files, export to arbitrary paths…),
//! and anything able to connect to the server could impersonate the app. Both
//! ends therefore authenticate each other with a per-launch secret:
//!
//! - On startup we generate a 256-bit random token and write it to
//!   `<app_data_dir>/automation-token` (user-profile directory, readable only by
//!   this user). The MCP server reads it from there.
//! - The token itself never crosses the WebSocket and never enters JS: the
//!   handshake is a mutual HMAC-SHA256 challenge/response, and the webview asks
//!   Rust to sign challenges via `automation_sign`.
//!
//! It is regenerated on every launch, so a stale copy is useless once the app
//! restarts.

use log::{info, warn};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use tauri::Manager;

#[cfg(feature = "tauri-cef")]
type AutomationAppHandle = tauri::AppHandle<tauri::Cef>;
#[cfg(not(feature = "tauri-cef"))]
type AutomationAppHandle = tauri::AppHandle<tauri::Wry>;

/// File name (inside the app data dir) the MCP server reads the token from.
/// Keep in sync with tools/dragonfruit-mcp/server.mjs.
const TOKEN_FILE_NAME: &str = "automation-token";
/// Bundled MCP server resource name. Keep in sync with tauri.conf.json.
const MCP_SERVER_RESOURCE: &str = "dragonfruit-mcp.cjs";

static TOKEN: OnceLock<String> = OnceLock::new();

fn token() -> &'static str {
    TOKEN.get_or_init(|| {
        let mut buf = [0u8; 32];
        getrandom::getrandom(&mut buf).expect("OS random number generator unavailable");
        buf.iter().map(|b| format!("{b:02x}")).collect()
    })
}

/// HMAC-SHA256 (RFC 2104) over SHA-256, so no extra crate is needed.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = {
        let mut h = Sha256::new();
        h.update(ipad);
        h.update(msg);
        h.finalize()
    };
    let mut h = Sha256::new();
    h.update(opad);
    h.update(inner);
    h.finalize().into()
}

fn token_file_path(app: &AutomationAppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(TOKEN_FILE_NAME))
}

/// Generate this launch's token and publish it for the MCP server.
pub fn init(app: &AutomationAppHandle) {
    let Some(path) = token_file_path(app) else {
        warn!("[automation] could not resolve app data dir; MCP bridge auth unavailable");
        return;
    };
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            warn!("[automation] could not create {}: {e}", dir.display());
            return;
        }
    }
    if let Err(e) = std::fs::write(&path, token()) {
        warn!("[automation] could not write token file {}: {e}", path.display());
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    info!("[automation] bridge token written to {}", path.display());
}

/// Sign a handshake message with this launch's token (hex HMAC-SHA256). The
/// webview uses this for both its own proof and to verify the server's proof,
/// so the token never leaves Rust.
#[tauri::command]
pub fn automation_sign(message: String) -> String {
    hmac_sha256(token().as_bytes(), message.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationInfo {
    /// Absolute path of the bundled MCP server script (None if not bundled).
    server_path: Option<String>,
    /// Where the per-launch token is published for the MCP server.
    token_file: Option<String>,
}

/// Paths the Settings > AI Assistant tab shows so the user can wire their MCP
/// client (Claude Desktop / Claude Code) to the bundled server.
#[tauri::command]
pub fn get_automation_info(app_handle: AutomationAppHandle) -> AutomationInfo {
    let server_path = app_handle
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join(MCP_SERVER_RESOURCE))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().trim_start_matches(r"\\?\").to_string());
    AutomationInfo {
        server_path,
        token_file: token_file_path(&app_handle).map(|p| p.to_string_lossy().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::hmac_sha256;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    // RFC 4231 test case 2.
    #[test]
    fn hmac_matches_rfc4231() {
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }
}
