use crate::auth;
use crate::error::ApiError;
use crate::routes;
use crate::state::AppState;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub fn router(state: AppState) -> Router {
    let public = Router::new().route("/api/v1/health", get(routes::health));

    let protected = Router::new()
        .route("/api/v1/revision", get(routes::revision))
        .route("/api/v1/accounts", get(routes::accounts))
        .route("/api/v1/threads", get(routes::threads))
        .route("/api/v1/threads/{id}", get(routes::thread))
        .route("/api/v1/messages/{id}", get(routes::message))
        .route("/api/v1/messages/{id}/body", get(routes::body))
        .route("/api/v1/messages/{id}/parts/{part}", get(routes::part))
        .route("/api/v1/tags", post(routes::tag))
        .route("/api/v1/sync", post(routes::sync))
        .route("/api/v1/send", post(routes::send))
        .route("/api/v1/events", get(routes::events))
        .layer(middleware::from_fn_with_state(state.clone(), require_token));

    public
        .merge(protected)
        .layer(cors())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn cors() -> CorsLayer {
    let origins: Vec<HeaderValue> = [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:1420",
        "http://localhost:5173",
    ]
    .iter()
    .filter_map(|o| o.parse().ok())
    .collect();

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::IF_NONE_MATCH,
        ])
        .expose_headers([header::ETAG])
}

async fn require_token(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if !state.requires_auth().await {
        return Ok(next.run(request).await);
    }

    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    let token = auth::bearer(presented)
        .or_else(|| query_token(request.uri().query()))
        .ok_or(ApiError::Unauthorized)?;

    let name = {
        let tokens = state.tokens.read().await;
        tokens.verify(token).map(|t| t.name.clone())
    };

    match name {
        Some(name) => {
            tracing::debug!(device = %name, "authenticated");
            Ok(next.run(request).await)
        }
        None => Err(ApiError::Unauthorized),
    }
}

fn query_token(query: Option<&str>) -> Option<&str> {
    query?
        .split('&')
        .find_map(|pair| pair.strip_prefix("access_token="))
        .filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_token_in_the_query_string() {
        assert_eq!(query_token(Some("access_token=abc")), Some("abc"));
        assert_eq!(query_token(Some("x=1&access_token=abc")), Some("abc"));
    }

    #[test]
    fn ignores_a_query_string_without_a_token() {
        assert_eq!(query_token(None), None);
        assert_eq!(query_token(Some("q=tag:inbox")), None);
        assert_eq!(query_token(Some("access_token=")), None);
    }
}
