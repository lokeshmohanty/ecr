use axum::extract::Request;
use axum::http::header::{CACHE_CONTROL, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::{self, Next};
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

    Router::new()
        .fallback_service(
            ServeDir::new(dir)
                .append_index_html_on_directories(true)
                .fallback(ServeFile::new(index)),
        )
        .layer(middleware::from_fn(cache_policy))
}

/// Whether a request names a file whose contents are in its name.
///
/// Vite content-hashes everything it emits into `assets/`, and nothing else in
/// `dist` is hashed at all — the document, the manifest, the worker and the
/// icons all keep the names they were written with.
fn is_content_hashed(path: &str) -> bool {
    path.starts_with("/assets/")
}

/// What may be cached, and for how long.
///
/// `ServeDir` sets `last-modified` and an `etag` and nothing else, which is
/// right for a directory of files with honest timestamps and wrong for every
/// way ecr is actually installed. A Nix store path normalises every mtime to
/// the epoch, so the document arrives claiming it was last modified in 1970
/// with no `cache-control` beside it — and a response carrying a validator and
/// no freshness information is one the browser is invited to guess about. The
/// guess is RFC 9111's heuristic, a tenth of the age, which against a 1970
/// timestamp is **five and a half years**. So a browser that has loaded the
/// client once never asks for it again: the cached `index.html` names the
/// hashed bundle that was current the day it was stored, that bundle is held
/// under the same rule, and the browser is frozen at that build for the life of
/// the profile. The desktop and Android shells read their copy out of the
/// binary and never make the request, so it presents as the browser being the
/// one client that has stopped receiving changes — and, for anyone whose cached
/// copy predates the manifest link, as an app that cannot be installed.
///
/// Revalidation would not have rescued it, which is why the validators are
/// stripped rather than merely paired with `no-cache`. That etag is
/// `mtime.nanos-size` and the mtime is the epoch in every store path, so it is
/// a function of the file's **length** alone — and the only thing that differs
/// in `index.html` between two builds is the eight-character hash in the asset
/// it names, which is eight characters long in both. Two different documents,
/// the same 845 bytes, the same etag, `304 Not Modified`. The request's own
/// conditionals go too: a browser that stored an etag before this existed would
/// otherwise go on being answered 304 by a server that has been fixed.
///
/// `assets/` is the opposite case and gets the opposite answer. The name is the
/// hash, so a URL that matches is the same bytes by construction and can be
/// kept for a year without ever being checked.
///
/// None of this is reachable from a development tree, where `web/dist` carries
/// the mtimes the build gave it and the etag changes with every build.
async fn cache_policy(mut request: Request, next: Next) -> Response {
    let hashed = is_content_hashed(request.uri().path());

    if !hashed {
        let headers = request.headers_mut();
        headers.remove(IF_NONE_MATCH);
        headers.remove(IF_MODIFIED_SINCE);
    }

    let mut response = next.run(request).await;
    let headers = response.headers_mut();

    if hashed {
        headers.insert(
            CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    } else {
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        headers.remove(ETAG);
        headers.remove(LAST_MODIFIED);
    }

    response
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

    /// A `dist` shaped like the one vite writes: a hashed bundle under
    /// `assets/`, and a document that names it.
    fn a_built_client() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("assets")).unwrap();
        std::fs::write(
            dir.path().join("assets/index-CGh53qWW.js"),
            "export default 0;",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("index.html"),
            "<script src=/assets/index-CGh53qWW.js></script>",
        )
        .unwrap();
        dir
    }

    async fn get(dir: &std::path::Path, path: &str, conditional: bool) -> Response {
        use tower::ServiceExt;

        let mut request = axum::http::Request::builder().uri(path);
        if conditional {
            // `*` matches whatever representation exists, so it needs no
            // knowledge of the etag — and the etag is the thing being denied.
            request = request.header(IF_NONE_MATCH, "*");
        }

        router(dir)
            .oneshot(request.body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_hashed_asset_is_kept_for_a_year() {
        let dir = a_built_client();

        let response = get(dir.path(), "/assets/index-CGh53qWW.js", false).await;

        assert_eq!(
            response.headers().get(CACHE_CONTROL).unwrap(),
            "public, max-age=31536000, immutable"
        );
    }

    #[tokio::test]
    async fn the_document_is_never_served_without_asking() {
        let dir = a_built_client();

        let response = get(dir.path(), "/", false).await;

        assert_eq!(response.headers().get(CACHE_CONTROL).unwrap(), "no-cache");
    }

    /// The etag is a function of the file's length in a store path, and every
    /// build's `index.html` is the same length. Leaving a validator on it is
    /// leaving a `304` that means nothing.
    #[tokio::test]
    async fn the_document_carries_no_validator_a_nix_build_would_repeat() {
        let dir = a_built_client();

        for path in ["/", "/index.html", "/manifest.webmanifest"] {
            let response = get(dir.path(), path, false).await;
            assert!(response.headers().get(ETAG).is_none(), "{path} has an etag");
            assert!(
                response.headers().get(LAST_MODIFIED).is_none(),
                "{path} has a last-modified"
            );
        }
    }

    #[tokio::test]
    async fn a_conditional_request_for_the_document_is_answered_in_full() {
        let dir = a_built_client();

        let response = get(dir.path(), "/index.html", true).await;

        assert_eq!(response.status(), StatusCode::OK);
    }

    /// Why the validators are stripped rather than merely paired with
    /// `no-cache`, which is the obvious half of the fix and is not enough.
    ///
    /// Two builds of the same client, laid out the way Nix lays one out: every
    /// mtime at the epoch, and an `index.html` that differs only in the
    /// eight-character hash of the bundle it names — so the two documents are
    /// different bytes at the same length. `ServeDir`'s etag is
    /// `mtime.nanos-size`, which under those conditions is the length alone, so
    /// it says the two are the same file. A browser revalidating against the
    /// second server would be told `304` and go on running the first.
    /// One build of the client, laid out the way Nix lays one out: every mtime
    /// at the epoch. Returns the etag `ServeDir` itself generates for the
    /// document — the layer is deliberately not applied, this being a question
    /// about what is underneath it.
    async fn store_path_etag(asset: &str) -> String {
        use tower::ServiceExt;

        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index.html");
        std::fs::write(&index, format!("<script src=/assets/{asset}.js></script>")).unwrap();

        let epoch = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1);
        std::fs::File::options()
            .write(true)
            .open(&index)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(epoch))
            .unwrap();

        let response = ServeDir::new(dir.path())
            .oneshot(
                axum::http::Request::builder()
                    .uri("/index.html")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        response
            .headers()
            .get(ETAG)
            .expect("ServeDir stopped setting an etag")
            .to_str()
            .unwrap()
            .to_string()
    }

    /// Why the validators are stripped rather than merely paired with
    /// `no-cache`, which is the obvious half of the fix and is not enough.
    ///
    /// Two builds differing only in the eight-character hash of the bundle the
    /// document names — different bytes, identical length — are given the same
    /// etag, because in a store path the mtime half of it is a constant. A
    /// browser revalidating against the second server would be told `304` and
    /// go on running the first.
    #[tokio::test]
    async fn two_builds_in_a_store_path_are_given_the_same_etag() {
        assert_eq!(
            store_path_etag("index-CGh53qWW").await,
            store_path_etag("index-Ba7TIBA6").await
        );
    }
}
