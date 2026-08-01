use crate::auth;
use crate::error::ApiError;
use crate::routes;
use crate::state::AppState;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderValue, Method};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post, put};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub fn router(state: AppState) -> Router {
    router_with_cors(state, None)
}

/// Serves until ctrl-c. Owning this here is what keeps axum out of the CLI.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: AppState,
    allowed_origins: Option<Vec<String>>,
    web_dir: Option<&std::path::Path>,
) -> anyhow::Result<()> {
    axum::serve(listener, router_with_web(state, allowed_origins, web_dir))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        })
        .await?;
    Ok(())
}

/// The API plus the built web client on the same origin, which is what lets a
/// browser reach `http://host:8383` and just work.
pub fn router_with_web(
    state: AppState,
    allowed_origins: Option<Vec<String>>,
    web_dir: Option<&std::path::Path>,
) -> Router {
    let api = router_with_cors(state, allowed_origins);

    match web_dir {
        Some(dir) => api.merge(crate::web::router(dir)),
        None => api.fallback(crate::web::missing),
    }
}

/// `allowed_origins` restricts the browser origins that may call the API.
/// The default is deliberately permissive: this API authenticates with a
/// bearer token and never uses cookies, so the Origin header is not a
/// security boundary — a hardcoded list would only break real deployments
/// (a tailnet hostname, a phone, a different port) while stopping nothing,
/// since a non-browser client ignores CORS entirely.
pub fn router_with_cors(state: AppState, allowed_origins: Option<Vec<String>>) -> Router {
    let public = Router::new().route("/api/v1/health", get(routes::health));

    let protected = Router::new()
        .route("/api/v1/revision", get(routes::revision))
        .route("/api/v1/accounts", get(routes::accounts))
        .route("/api/v1/addresses", get(routes::addresses))
        .route("/api/v1/tags", get(routes::tags))
        .route("/api/v1/counts", post(routes::counts))
        .route("/api/v1/threads", get(routes::threads))
        .route("/api/v1/threads/{id}", get(routes::thread))
        .route("/api/v1/messages/{id}", get(routes::message))
        .route("/api/v1/messages/{id}/body", get(routes::body))
        .route("/api/v1/messages/{id}/parts/{part}", get(routes::part))
        .route("/api/v1/tags", post(routes::tag))
        .route("/api/v1/sync", post(routes::sync))
        .route(
            "/api/v1/send",
            // A draft carries its attachments base64 in the same request, so
            // this route alone needs room for the 25MB cap plus the ~4/3
            // encoding overhead. Axum's 2MB default truncated the body, which
            // surfaced as an unintelligible parse error rather than a refusal.
            post(routes::send).layer(DefaultBodyLimit::max(36 * 1024 * 1024)),
        )
        .route("/api/v1/events", get(routes::events))
        .route("/api/v1/config", get(routes::config))
        .route("/api/v1/config", put(routes::save_config))
        .route("/api/v1/themes", get(routes::themes))
        .route("/api/v1/theme", get(routes::theme))
        .route("/api/v1/theme", put(routes::save_theme))
        .layer(middleware::from_fn_with_state(state.clone(), require_token));

    public
        .merge(protected)
        .layer(cors(allowed_origins))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn cors(allowed_origins: Option<Vec<String>>) -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::OPTIONS])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::IF_NONE_MATCH,
        ])
        .expose_headers([header::ETAG]);

    let parsed: Vec<HeaderValue> = allowed_origins
        .unwrap_or_default()
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();

    if parsed.is_empty() {
        layer.allow_origin(tower_http::cors::Any)
    } else {
        layer.allow_origin(parsed)
    }
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
