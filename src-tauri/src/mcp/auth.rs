// ============================================
// MCP Authentication
// API Key validation + rate limiting
// ============================================

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tokio::sync::Mutex;

/// Auth state: API key + rate limiter
#[derive(Clone)]
pub struct AuthState {
    /// Required API key for authentication
    api_key: String,
    /// Rate limiter
    rate_limiter: Arc<Mutex<RateLimiter>>,
}

impl AuthState {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            rate_limiter: Arc::new(Mutex::new(RateLimiter::new(60, Duration::from_secs(60)))),
        }
    }
}

/// Simple sliding-window rate limiter
struct RateLimiter {
    timestamps: VecDeque<Instant>,
    max_requests: usize,
    window: Duration,
}

impl RateLimiter {
    fn new(max_requests: usize, window: Duration) -> Self {
        Self {
            timestamps: VecDeque::new(),
            max_requests,
            window,
        }
    }

    /// Returns true if request is allowed, false if rate limited
    fn check(&mut self) -> bool {
        let now = Instant::now();
        let cutoff = now - self.window;

        // Remove expired timestamps
        while self.timestamps.front().is_some_and(|&t| t < cutoff) {
            self.timestamps.pop_front();
        }

        if self.timestamps.len() >= self.max_requests {
            false
        } else {
            self.timestamps.push_back(now);
            true
        }
    }
}

/// Extract API key from request headers.
/// Supports: `Authorization: Bearer <key>` and `X-API-Key: <key>`
/// Constant-time byte-slice equality to avoid leaking a timing oracle on the
/// API key comparison. The length check is allowed to short-circuit (key length
/// is not secret); the byte comparison itself runs in constant time.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Validate that a request targets the loopback interface and, if a browser
/// `Origin` is present, that it too is loopback. This defends against
/// DNS-rebinding attacks: a malicious website cannot point a hostname at
/// 127.0.0.1 and drive the local MCP server, because the forged `Host`/`Origin`
/// header will not match the loopback allowlist.
///
/// Non-browser MCP clients (e.g. the Copilot CLI) typically send no `Origin`
/// header at all, which is allowed. A `Host` header, when present, must resolve
/// to loopback.
fn is_loopback_host(value: &str) -> bool {
    // Strip an optional port; take the host portion.
    let host = value.rsplit_once(':').map(|(h, _)| h).unwrap_or(value);
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host == "127.0.0.1"
        || host == "::1"
        || host.starts_with("127.")
}

fn is_allowed_origin(origin: &str) -> bool {
    let origin = origin.trim();
    if origin.eq_ignore_ascii_case("null") {
        return true;
    }
    // Parse scheme://host[:port]
    let after_scheme = match origin.split_once("://") {
        Some((_, rest)) => rest,
        None => return false,
    };
    // Strip any path.
    let authority = after_scheme.split('/').next().unwrap_or(after_scheme);
    is_loopback_host(authority)
}

/// Returns true if the request's Host/Origin headers are acceptable for a
/// loopback-only server.
fn origin_host_allowed(headers: &HeaderMap) -> bool {
    // Host header (if present) must be loopback.
    if let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) {
        if !is_loopback_host(host) {
            return false;
        }
    }
    // Origin header (if present) must be loopback / null.
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        if !is_allowed_origin(origin) {
            return false;
        }
    }
    true
}

fn extract_api_key(headers: &HeaderMap) -> Option<&str> {
    // Try Authorization: Bearer <key>
    if let Some(key) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        return Some(key);
    }
    // Try X-API-Key header
    headers.get("x-api-key").and_then(|v| v.to_str().ok())
}

/// Axum middleware: API key authentication + rate limiting.
pub async fn auth_middleware(
    State(auth_state): State<AuthState>,
    headers: HeaderMap,
    request: Request<Body>,
    next: Next,
) -> Result<Response, Response> {
    // Check rate limit first
    {
        let mut limiter = auth_state.rate_limiter.lock().await;
        if !limiter.check() {
            tracing::warn!("MCP rate limit exceeded");
            return Err(StatusCode::TOO_MANY_REQUESTS.into_response());
        }
    }

    // Reject cross-origin / non-loopback requests early (DNS-rebinding defense).
    if !origin_host_allowed(&headers) {
        tracing::warn!("MCP auth: rejected non-loopback Host/Origin");
        return Err(StatusCode::FORBIDDEN.into_response());
    }

    let method = request.method().clone();
    let uri = request.uri().path().to_string();

    match extract_api_key(&headers) {
        Some(key) if constant_time_eq(key.as_bytes(), auth_state.api_key.as_bytes()) => {
            tracing::debug!("MCP auth OK: {} {}", method, uri);
            Ok(next.run(request).await)
        }
        Some(_) => {
            tracing::warn!("MCP auth: invalid API key ({} {})", method, uri);
            Err(StatusCode::UNAUTHORIZED.into_response())
        }
        None => {
            tracing::warn!("MCP auth: no API key provided ({} {})", method, uri);
            Err(StatusCode::UNAUTHORIZED.into_response())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rate_limiter() {
        let mut limiter = RateLimiter::new(3, Duration::from_secs(60));
        assert!(limiter.check());
        assert!(limiter.check());
        assert!(limiter.check());
        assert!(!limiter.check()); // 4th request should be denied
    }

    #[test]
    fn test_loopback_host() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.0.0.1:3100"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("localhost:3100"));
        assert!(is_loopback_host("[::1]:3100"));
        assert!(!is_loopback_host("evil.example.com"));
        assert!(!is_loopback_host("evil.example.com:3100"));
        assert!(!is_loopback_host("10.0.0.5"));
    }

    #[test]
    fn test_allowed_origin() {
        assert!(is_allowed_origin("null"));
        assert!(is_allowed_origin("http://localhost:3100"));
        assert!(is_allowed_origin("http://127.0.0.1:5173"));
        assert!(is_allowed_origin("https://localhost"));
        assert!(!is_allowed_origin("https://attacker.com"));
        assert!(!is_allowed_origin("http://internal.corp:3100"));
        assert!(!is_allowed_origin("garbage"));
    }

    #[test]
    fn test_origin_host_allowed() {
        let mut ok = HeaderMap::new();
        ok.insert("host", "127.0.0.1:3100".parse().unwrap());
        assert!(origin_host_allowed(&ok));

        let mut bad_host = HeaderMap::new();
        bad_host.insert("host", "attacker.com".parse().unwrap());
        assert!(!origin_host_allowed(&bad_host));

        let mut bad_origin = HeaderMap::new();
        bad_origin.insert("host", "127.0.0.1:3100".parse().unwrap());
        bad_origin.insert("origin", "https://attacker.com".parse().unwrap());
        assert!(!origin_host_allowed(&bad_origin));

        // No headers at all (typical non-browser MCP client) is allowed.
        assert!(origin_host_allowed(&HeaderMap::new()));
    }
}
