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
    headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
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

    let method = request.method().clone();
    let uri = request.uri().path().to_string();

    match extract_api_key(&headers) {
        Some(key) if key == auth_state.api_key => {
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
}
