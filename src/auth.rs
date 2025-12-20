use actix_web::{dev::ServiceRequest, HttpRequest, HttpResponse};
use std::sync::Arc;

use crate::config::ConfigManager;

/// Extract token from HttpRequest (query param or Authorization header)
pub fn extract_token_from_request(req: &HttpRequest) -> Option<String> {
    // Try query parameter first: ?token=xxx
    if let Some(token) = req.query_string().split('&').find_map(|pair| {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next()?;
        let value = parts.next()?;
        if key == "token" {
            Some(value.to_string())
        } else {
            None
        }
    }) {
        return Some(token);
    }

    // Try Authorization header: Bearer xxx
    if let Some(auth_header) = req.headers().get("Authorization") {
        if let Ok(auth_str) = auth_header.to_str() {
            if let Some(token) = auth_str.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }

    None
}

/// Check auth from HttpRequest - returns Ok(()) if valid, Err(HttpResponse) if not
pub fn check_auth(req: &HttpRequest, config: &Arc<ConfigManager>) -> Result<(), HttpResponse> {
    match extract_token_from_request(req) {
        Some(token) if config.verify_token(&token) => Ok(()),
        Some(_) => Err(HttpResponse::Unauthorized().json(serde_json::json!({
            "error": "Invalid token"
        }))),
        None => Err(HttpResponse::Unauthorized().json(serde_json::json!({
            "error": "Authentication required",
            "hint": "Provide token via ?token=xxx or Authorization: Bearer xxx"
        }))),
    }
}

/// Extract token from ServiceRequest (query param or Authorization header)
pub fn extract_token(req: &ServiceRequest) -> Option<String> {
    // Try query parameter first: ?token=xxx
    if let Some(token) = req.query_string().split('&').find_map(|pair| {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next()?;
        let value = parts.next()?;
        if key == "token" {
            Some(value.to_string())
        } else {
            None
        }
    }) {
        return Some(token);
    }

    // Try Authorization header: Bearer xxx
    if let Some(auth_header) = req.headers().get("Authorization") {
        if let Ok(auth_str) = auth_header.to_str() {
            if let Some(token) = auth_str.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }

    None
}

/// Check if a path requires authentication
pub fn requires_auth(path: &str) -> bool {
    // API endpoints require auth (except auth check)
    if path.starts_with("/api/") {
        // Allow unauthenticated access to auth check endpoint
        if path == "/api/auth/check" {
            return false;
        }
        return true;
    }

    // WebSocket requires auth
    if path == "/ws" {
        return true;
    }

    // Static files don't require auth
    false
}

/// Verify token and return error response if invalid
pub fn verify_request(
    req: &ServiceRequest,
    config: &Arc<ConfigManager>,
) -> Result<(), HttpResponse> {
    let path = req.path();

    if !requires_auth(path) {
        return Ok(());
    }

    match extract_token(req) {
        Some(token) if config.verify_token(&token) => Ok(()),
        Some(_) => {
            log::warn!("Invalid token for path: {}", path);
            Err(HttpResponse::Unauthorized().json(serde_json::json!({
                "error": "Invalid token"
            })))
        }
        None => {
            log::warn!("Missing token for path: {}", path);
            Err(HttpResponse::Unauthorized().json(serde_json::json!({
                "error": "Authentication required",
                "hint": "Provide token via ?token=xxx query param or Authorization: Bearer xxx header"
            })))
        }
    }
}

/// Handler for /api/auth/check endpoint
pub async fn auth_check_handler(
    req: actix_web::HttpRequest,
    config: actix_web::web::Data<Arc<ConfigManager>>,
) -> HttpResponse {
    let token = req
        .query_string()
        .split('&')
        .find_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next()?;
            if key == "token" {
                Some(value.to_string())
            } else {
                None
            }
        })
        .or_else(|| {
            req.headers()
                .get("Authorization")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
                .map(|s| s.to_string())
        });

    match token {
        Some(t) if config.verify_token(&t) => HttpResponse::Ok().json(serde_json::json!({
            "valid": true,
            "message": "Token is valid"
        })),
        Some(_) => HttpResponse::Unauthorized().json(serde_json::json!({
            "valid": false,
            "error": "Invalid token"
        })),
        None => HttpResponse::BadRequest().json(serde_json::json!({
            "valid": false,
            "error": "No token provided"
        })),
    }
}
