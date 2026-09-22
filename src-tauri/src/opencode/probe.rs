//! Spawn prerequisites and readiness probing: a free loopback port, the
//! generated server password (plus the base64 the basic-auth header
//! needs), and the minimal HTTP client that polls the server until it
//! answers an authenticated API call with JSON.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// How long to wait for the spawned server to answer API calls before giving
/// up. First runs may need to index the project, so be generous.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Grab a free loopback port by binding to :0 and immediately releasing it.
/// Racy in theory, unobservable in practice for a single-spawn app.
pub(super) fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("failed to reserve a port: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("failed to read reserved port: {e}"))
}

/// Minimal standard-alphabet base64 (no crate for 24 bytes of credentials).
pub(super) fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let bytes = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2]);
        out.push(TABLE[(n >> 18 & 63) as usize] as char);
        out.push(TABLE[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Random password from /dev/urandom (16 bytes → 22 usable chars).
pub(super) fn generate_password() -> String {
    // Read exactly 16 bytes from the entropy source.
    let bytes = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| {
            use std::io::Read;
            let mut buf = [0u8; 16];
            f.read_exact(&mut buf).map(|_| buf.to_vec())
        })
        .unwrap_or_else(|_| {
            // Fallback: time-based entropy (good enough for a loopback-only
            // server we spawned ourselves).
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            now.to_le_bytes().iter().copied().chain([7u8; 8]).collect()
        });
    base64_encode(&bytes)
}

/// Minimal HTTP/1.1 GET returning (status, body). Avoids an HTTP-client
/// dependency for what is a loopback readiness probe.
fn http_get(port: u16, path: &str, authorization: &str) -> Result<(u16, String), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("connect: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| format!("set read timeout: {e}"))?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nAuthorization: {authorization}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("read: {e}"))?;
    let text = String::from_utf8_lossy(&raw);
    let mut parts = text.splitn(2, "\r\n\r\n");
    let headers = parts.next().unwrap_or_default();
    let body = parts.next().unwrap_or_default().to_string();
    // "HTTP/1.1 200 OK" → 200
    let status = headers
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| "malformed HTTP status line".to_string())?;
    Ok((status, body))
}

/// Poll until the server answers an authenticated API call with JSON.
pub(super) fn wait_until_ready(port: u16, authorization: &str) -> Result<(), String> {
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    let mut last_err = String::from("no attempt made");
    while Instant::now() < deadline {
        match http_get(port, "/api/session", authorization) {
            Ok((200, body)) if !body.trim_start().starts_with('<') => return Ok(()),
            Ok((status, body)) => {
                let preview: String = body.chars().take(60).collect();
                last_err = format!("status {status}, body: {preview}");
            }
            Err(e) => last_err = e,
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    }
    Err(format!(
        "server did not answer API calls within {}s: {last_err}",
        HEALTH_TIMEOUT.as_secs()
    ))
}
