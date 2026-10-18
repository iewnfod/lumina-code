//! lumina-server HTTP transport — the Rust half of
//! `opencode/serverConnection.ts`'s LuminaServerApi.
//!
//! WHY this exists (live-observed 2026-10-18, on a phone-hotspot network
//! with a local proxy): the desktop's requests to the self-hosted
//! lumina-server used to go through the WEBVIEW's fetch — and the
//! WebKitGTK network stack (libsoup/GnuTLS under tauri/wry) failed to
//! complete those requests on EVERY path (system proxy, direct, clean
//! env) with an opaque `TypeError: Load failed`, while curl (OpenSSL),
//! bare libsoup and a bare WebKitGTK page against the same host all
//! succeeded. A desktop↔server backend channel has no business riding
//! the browser's proxy/TLS stack — it must not drift with the user's
//! proxy software, their rules, or the network's TLS-fingerprint
//! handling. So LuminaServerApi now invokes this command instead of
//! fetch: plain reqwest (native-tls = the curl-proven stack), proxies
//! explicitly DISABLED (the server is reached like any other local
//! backend service), one JSON-string-in/JSON-string-out shape covering
//! every method the client needs.
//!
//! Error contract: transport failures arrive as the command's Err
//! (String); HTTP responses ALWAYS arrive as Ok(LuminaReply) — the
//! client decides what a 4xx/5xx means (it maps `{error}` bodies to
//! messages and tags `.status`, same as the old fetch-based shape).

use serde::Serialize;
use std::time::Duration;

/// Mirrors the shape `LuminaServerApi` expects (camelCase on the wire).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuminaReply {
    pub status: u16,
    /// Raw response body (JSON text, or empty for 204s).
    pub body: String,
}

#[tauri::command]
pub async fn lumina_request(
    base_url: String,
    token: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<LuminaReply, String> {
    // Rebuild per call: requests are rare (registration + 5-minute
    // heartbeats + settings interactions), and this sidesteps any
    // client-identity caching across server/url changes.
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;

    let url = format!("{base_url}{path}");
    let method = method
        .parse::<reqwest::Method>()
        .map_err(|e| format!("invalid method {method:?}: {e}"))?;
    let mut req = client
        .request(method, &url)
        .header("Accept", "application/json");
    if !token.is_empty() {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    if let Some(body) = body {
        req = req.header("Content-Type", "application/json").body(body);
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("request to {url} failed: {e}"))?;
    let status = res.status().as_u16();
    let body = res
        .text()
        .await
        .map_err(|e| format!("reading response from {url} failed: {e}"))?;
    Ok(LuminaReply { status, body })
}
