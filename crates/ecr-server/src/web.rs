use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Router;
use std::path::{Path, PathBuf};
use tower_http::services::{ServeDir, ServeFile};

/// Where the built web client lives.
///
/// Serving the UI from the same origin as the API is what makes the browser
/// case work with no configuration: CORS never enters the picture, and the
/// client defaults its API base to `location.origin`.
pub fn locate(explicit: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = explicit {
        return dir.join("index.html").is_file().then_some(dir);
    }

    if let Some(dir) = std::env::var_os("ECR_WEB_DIR").map(PathBuf::from) {
        if dir.join("index.html").is_file() {
            return Some(dir);
        }
    }

    candidates()
        .into_iter()
        .find(|d| d.join("index.html").is_file())
}

fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("web/dist"));
        out.push(cwd.join("dist"));
    }

    // Beside or above the binary, which covers `cargo run` from the workspace
    // root and an installed layout alike.
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().skip(1).take(4) {
            out.push(ancestor.join("web/dist"));
            out.push(ancestor.join("share/ecr/web"));
        }
    }

    out
}

/// Serves the client, falling back to `index.html` so client-side routes and a
/// hard refresh both work. API routes are matched first by the caller.
pub fn router(dir: &Path) -> Router {
    let index = dir.join("index.html");

    Router::new().fallback_service(
        ServeDir::new(dir)
            .append_index_html_on_directories(true)
            .fallback(ServeFile::new(index)),
    )
}

pub async fn missing() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        MISSING_PAGE,
    )
        .into_response()
}

const MISSING_PAGE: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>ecr — client not built</title>
<style>
  body { background:#1a1b26; color:#c0caf5; font-family:ui-monospace,monospace;
         display:grid; place-items:center; height:100vh; margin:0; }
  div { max-width:34rem; padding:2rem; }
  h1 { color:#7aa2f7; font-size:1.1rem; }
  code { background:#1f2335; padding:.15rem .4rem; border-radius:.2rem; color:#9ece6a; }
  p { line-height:1.7; }
</style>
<div>
  <h1>The web client has not been built</h1>
  <p>The API is running here, but there is no <code>web/dist</code> to serve.</p>
  <p>Build it with <code>just build-web</code>, then reload. For hot reload
     during development run <code>just dev</code> and use
     <code>http://localhost:1420</code> instead.</p>
</div>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_directory_without_an_index_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(locate(Some(dir.path().to_path_buf())), None);
    }

    #[test]
    fn an_explicit_directory_with_an_index_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<html>").unwrap();

        assert_eq!(
            locate(Some(dir.path().to_path_buf())),
            Some(dir.path().to_path_buf())
        );
    }

    #[test]
    fn candidates_include_the_workspace_layout() {
        let paths = candidates();
        assert!(paths.iter().any(|p| p.ends_with("web/dist")), "{paths:?}");
    }

    #[test]
    fn the_missing_page_explains_how_to_fix_it() {
        assert!(MISSING_PAGE.contains("just build-web"));
        assert!(MISSING_PAGE.contains("just dev"));
    }
}
