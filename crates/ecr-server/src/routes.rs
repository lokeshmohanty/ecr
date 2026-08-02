use crate::error::{ApiError, ApiResult};
use crate::events::{ServerEvent, SyncProgress};
use crate::state::AppState;
use axum::extract::{Path, Query as AxumQuery, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use ecr_core::account::{Account, AccountId};
use ecr_core::doctor::Doctor;
use ecr_core::message::{
    Body, BodyFormat, Message, MessageId, PartId, Query, SyncReport, TagOp, Thread, ThreadId,
};
use ecr_core::revision::Revision;
use ecr_store::store::{BodyOptions, MailStore};
use futures::stream::Stream;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct Page<T> {
    pub revision: Revision,
    pub total: usize,
    pub items: Vec<T>,
}

#[derive(Debug, Deserialize)]
pub struct ThreadQuery {
    #[serde(default)]
    pub q: String,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

impl ThreadQuery {
    fn to_query(&self) -> Query {
        Query::new(self.q.clone())
            .limit(self.limit.unwrap_or(Query::DEFAULT_LIMIT).clamp(1, 500))
            .offset(self.offset.unwrap_or(0))
    }
}

pub async fn health(State(state): State<AppState>) -> Json<Doctor> {
    Json(state.store.doctor().await)
}

pub async fn revision(State(state): State<AppState>) -> ApiResult<Json<Revision>> {
    Ok(Json(state.store.revision().await?))
}

pub async fn accounts(State(state): State<AppState>) -> ApiResult<Json<Vec<Account>>> {
    Ok(Json(state.store.accounts().await?))
}

#[derive(Serialize)]
pub struct AddressEntry {
    pub name: Option<String>,
    pub email: String,
    pub source: &'static str,
    pub count: usize,
}

/// The address book, for recipient completion in the composer.
pub async fn addresses(State(state): State<AppState>) -> ApiResult<Json<Vec<AddressEntry>>> {
    let book = state.store.notmuch().address_book(0).await?;

    Ok(Json(
        book.ranked()
            .into_iter()
            .map(|entry| AddressEntry {
                name: entry.address.name,
                email: entry.address.email,
                source: match entry.source {
                    ecr_store::address::Source::Recipient => "recipient",
                    ecr_store::address::Source::Sender => "sender",
                },
                count: entry.count,
            })
            .collect(),
    ))
}

/// Every tag in the database, for query completion.
pub async fn tags(State(state): State<AppState>) -> ApiResult<Json<Vec<String>>> {
    Ok(Json(state.store.notmuch().tags().await?))
}

/// How many recent messages the list scan reads headers from.
const LIST_SCAN: usize = 2000;

#[derive(Serialize)]
pub struct Lists {
    pub lists: Vec<ecr_store::notmuch::MailingList>,
    /// False when `index.header.List` is unset, which makes `List:` unsearchable
    /// and every row below useless. The client says so rather than showing rows
    /// that match nothing.
    pub searchable: bool,
}

pub async fn lists(State(state): State<AppState>) -> ApiResult<Json<Lists>> {
    let notmuch = state.store.notmuch();
    Ok(Json(Lists {
        lists: notmuch.mailing_lists(LIST_SCAN).await?,
        searchable: notmuch.indexes_list_id().await,
    }))
}

/// How many queries one request may ask about.
///
/// The sidebar sends a query per visible row, which is tens. A cap keeps a
/// single request from turning into an unbounded amount of Xapian work.
const MAX_COUNT_QUERIES: usize = 200;

#[derive(Deserialize)]
pub struct CountsRequest {
    pub queries: Vec<String>,
}

#[derive(Serialize)]
pub struct CountsResponse {
    /// Positional, matching the request: duplicate queries stay cheap and the
    /// client zips by index rather than re-deriving the key it sent.
    pub counts: Vec<u64>,
}

pub async fn counts(
    State(state): State<AppState>,
    Json(request): Json<CountsRequest>,
) -> ApiResult<Json<CountsResponse>> {
    if request.queries.len() > MAX_COUNT_QUERIES {
        return Err(ApiError::BadRequest(format!(
            "at most {MAX_COUNT_QUERIES} queries per request, got {}",
            request.queries.len()
        )));
    }

    let counts = state.store.count_batch(&request.queries).await?;
    Ok(Json(CountsResponse { counts }))
}

pub async fn threads(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumQuery(params): AxumQuery<ThreadQuery>,
) -> ApiResult<Response> {
    let revision = state.store.revision().await?;

    if let Some(etag) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
    {
        if etag == revision.etag() {
            return Ok(StatusCode::NOT_MODIFIED.into_response());
        }
    }

    let query = params.to_query();
    let items = state.store.search_threads(&query).await?;
    let total = state.store.count(&query).await?;

    let etag = revision.etag();
    let page = Page {
        revision,
        total,
        items,
    };

    Ok(([(header::ETAG, etag)], Json(page)).into_response())
}

pub async fn thread(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Thread>> {
    let thread = state.store.thread(&ThreadId(id)).await?;
    if thread.messages.is_empty() {
        return Err(ApiError::NotFound("no such thread".to_string()));
    }
    Ok(Json(thread))
}

pub async fn message(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Message>> {
    Ok(Json(state.store.message(&MessageId(id)).await?))
}

#[derive(Debug, Deserialize)]
pub struct BodyQuery {
    #[serde(default)]
    pub html: Option<bool>,
    #[serde(default)]
    pub remote: Option<bool>,
}

pub async fn body(
    State(state): State<AppState>,
    Path(id): Path<String>,
    AxumQuery(params): AxumQuery<BodyQuery>,
) -> ApiResult<Json<Body>> {
    let options = BodyOptions {
        format: if params.html.unwrap_or(true) {
            BodyFormat::Html
        } else {
            BodyFormat::Text
        },
        allow_remote_resources: params.remote.unwrap_or(false),
    };

    Ok(Json(state.store.body(&MessageId(id), options).await?))
}

pub async fn part(
    State(state): State<AppState>,
    Path((id, part)): Path<(String, u32)>,
) -> ApiResult<Response> {
    let part = state.store.part(&MessageId(id), &PartId(part)).await?;

    let disposition = match &part.meta.filename {
        Some(name) => format!("attachment; filename=\"{}\"", sanitize_filename(name)),
        None => "inline".to_string(),
    };

    Ok((
        [
            (header::CONTENT_TYPE, part.meta.content_type.clone()),
            (header::CONTENT_DISPOSITION, disposition),
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable".to_string(),
            ),
        ],
        part.bytes,
    )
        .into_response())
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, '"' | '\\' | '\r' | '\n'))
        .collect()
}

#[derive(Debug, Deserialize)]
pub struct TagRequest {
    pub ops: Vec<TagOp>,
}

pub async fn tag(
    State(state): State<AppState>,
    Json(request): Json<TagRequest>,
) -> ApiResult<Json<Revision>> {
    reject_if_read_only(&state)?;

    let ids: Vec<String> = request.ops.iter().map(|o| o.id.to_string()).collect();
    let revision = state.store.tag(&request.ops).await?;
    state.note_own_write(&revision).await;

    state.events.publish(ServerEvent::TagsChanged {
        revision: revision.clone(),
        ids,
    });

    Ok(Json(revision))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SyncRequest {
    pub accounts: Vec<String>,
}

pub async fn sync(
    State(state): State<AppState>,
    body: Option<Json<SyncRequest>>,
) -> ApiResult<Json<SyncReport>> {
    reject_if_read_only(&state)?;

    let accounts: Vec<AccountId> = body
        .map(|Json(r)| r.accounts)
        .unwrap_or_default()
        .into_iter()
        .map(AccountId)
        .collect();

    state.events.publish(ServerEvent::SyncStarted {
        accounts: accounts.iter().map(|a| a.to_string()).collect(),
    });

    let progress = SyncProgress::new(state.events.clone());
    let report = match state.store.sync(&accounts, &progress).await {
        Ok(report) => report,
        Err(err) => {
            state.events.publish(ServerEvent::Error {
                detail: err.to_string(),
            });
            return Err(err.into());
        }
    };

    let revision = state.store.revision().await?;
    state.events.publish(ServerEvent::SyncFinished {
        new_messages: report.new_messages,
        revision,
    });

    Ok(Json(report))
}

#[derive(Debug, Deserialize)]
pub struct SendRequest {
    pub account: String,
    #[serde(flatten)]
    pub draft: ecr_core::compose::Draft,
}

pub async fn send(
    State(state): State<AppState>,
    Json(request): Json<SendRequest>,
) -> ApiResult<Json<SendResponse>> {
    reject_if_read_only(&state)?;

    let accounts = state.store.accounts().await?;
    let account = accounts
        .iter()
        .find(|a| a.id.as_str() == request.account)
        .ok_or_else(|| ApiError::BadRequest(format!("no account named {}", request.account)))?;

    let raw = ecr_store::compose::build(account, &request.draft)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    state.store.send(&account.id, &raw).await?;

    Ok(Json(SendResponse {
        bytes: raw.len(),
        account: account.id.to_string(),
    }))
}

#[derive(Serialize)]
pub struct SendResponse {
    pub bytes: usize,
    pub account: String,
}

pub async fn events(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    use tokio_stream::wrappers::BroadcastStream;
    use tokio_stream::StreamExt;

    let stream = BroadcastStream::new(state.events.subscribe()).filter_map(|event| {
        let event = event.ok()?;
        Some(Ok(Event::default()
            .event(event.name())
            .json_data(&event)
            .unwrap_or_else(|_| {
                Event::default().data("serialization failed")
            })))
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

fn reject_if_read_only(state: &AppState) -> ApiResult<()> {
    if state.read_only {
        return Err(ApiError::BadRequest(
            "the server is running in --read-only mode".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thread_query_clamps_an_absurd_limit() {
        let params = ThreadQuery {
            q: "tag:inbox".to_string(),
            limit: Some(100_000),
            offset: None,
        };
        assert_eq!(params.to_query().limit, 500);
    }

    #[test]
    fn a_zero_limit_becomes_one_rather_than_returning_nothing() {
        let params = ThreadQuery {
            q: String::new(),
            limit: Some(0),
            offset: None,
        };
        assert_eq!(params.to_query().limit, 1);
    }

    #[test]
    fn an_absent_limit_uses_the_default() {
        let params = ThreadQuery {
            q: String::new(),
            limit: None,
            offset: None,
        };
        assert_eq!(params.to_query().limit, Query::DEFAULT_LIMIT);
    }

    #[test]
    fn a_filename_cannot_break_out_of_the_content_disposition_header() {
        assert_eq!(
            sanitize_filename("evil\";\r\nX-Injected: yes\".pdf"),
            "evil;X-Injected: yes.pdf"
        );
    }

    #[test]
    fn an_ordinary_filename_survives() {
        assert_eq!(sanitize_filename("report 2026.pdf"), "report 2026.pdf");
    }
}

#[derive(Serialize)]
pub struct ConfigFile {
    pub path: String,
    pub raw: String,
}

/// The settings file every client shares. Absent is not an error — a client
/// that finds it empty writes the commented default into it.
pub async fn config(State(state): State<AppState>) -> ApiResult<Json<ConfigFile>> {
    let path = state.store.paths().settings_file();
    let raw = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(ApiError::Internal(err.to_string())),
    };

    Ok(Json(ConfigFile {
        path: path.display().to_string(),
        raw,
    }))
}

#[derive(Deserialize)]
pub struct ConfigUpdate {
    pub raw: String,
}

#[derive(Serialize)]
pub struct ConfigRejected {
    pub error: &'static str,
    pub detail: String,
    pub line: usize,
    pub column: usize,
}

/// Written only if it parses, so a client that sends nonsense cannot leave the
/// user with a settings file that no client can read back.
pub async fn save_config(
    State(state): State<AppState>,
    Json(update): Json<ConfigUpdate>,
) -> Response {
    if let Err(err) = update.raw.parse::<toml::Table>() {
        let (line, column) = err
            .span()
            .map(|span| position(&update.raw, span.start))
            .unwrap_or((1, 1));

        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ConfigRejected {
                error: "invalid_toml",
                detail: err.message().to_string(),
                line,
                column,
            }),
        )
            .into_response();
    }

    let path = state.store.paths().settings_file();
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            return ApiError::Internal(err.to_string()).into_response();
        }
    }

    match write_atomically(&path, &update.raw) {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "path": path.display().to_string() })),
        )
            .into_response(),
        Err(err) => ApiError::Internal(err.to_string()).into_response(),
    }
}

#[derive(Serialize)]
pub struct ThemeListing {
    pub dir: String,
    pub presets: Vec<ThemeEntry>,
}

#[derive(Serialize)]
pub struct ThemeEntry {
    /// The value that goes in settings.toml, relative to the config dir.
    pub path: String,
    /// The display name from the file, falling back to the stem.
    pub name: String,
    pub builtin: bool,
}

/// Every theme on disk, seeded with the shipped presets on first call so a fresh
/// install has something to pick from.
pub async fn themes(State(state): State<AppState>) -> ApiResult<Json<ThemeListing>> {
    let dir = state.store.paths().themes_dir();
    ecr_store::themes::seed(&dir).map_err(|e| ApiError::Internal(e.to_string()))?;

    let builtin: std::collections::HashSet<&str> =
        ecr_store::themes::PRESETS.iter().map(|(n, _)| *n).collect();

    let mut presets = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| ApiError::Internal(e.to_string()))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("toml") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };

        let name = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| raw.parse::<toml::Table>().ok())
            .and_then(|doc| doc.get("name")?.as_str().map(str::to_string))
            .unwrap_or_else(|| stem.to_string());

        presets.push(ThemeEntry {
            path: format!("themes/{stem}.toml"),
            name,
            builtin: builtin.contains(stem),
        });
    }

    presets.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(Json(ThemeListing {
        dir: dir.display().to_string(),
        presets,
    }))
}

#[derive(Deserialize)]
pub struct ThemeQuery {
    pub path: String,
}

/// Unlike the settings file, a theme that is not there is a real error: the file
/// was named by settings.toml, so its absence is a broken link the user should
/// see rather than an empty palette that silently does nothing.
pub async fn theme(
    State(state): State<AppState>,
    AxumQuery(query): AxumQuery<ThemeQuery>,
) -> ApiResult<Json<ConfigFile>> {
    let path = state
        .store
        .paths()
        .resolve_relative(&query.path)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    let raw = std::fs::read_to_string(&path).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => ApiError::NotFound(format!("no theme at {}", query.path)),
        _ => ApiError::Internal(err.to_string()),
    })?;

    Ok(Json(ConfigFile {
        path: path.display().to_string(),
        raw,
    }))
}

#[derive(Deserialize)]
pub struct ThemeUpdate {
    pub path: String,
    pub raw: String,
}

pub async fn save_theme(
    State(state): State<AppState>,
    Json(update): Json<ThemeUpdate>,
) -> Response {
    let path = match state.store.paths().resolve_relative(&update.path) {
        Ok(path) => path,
        Err(err) => return ApiError::BadRequest(err.to_string()).into_response(),
    };

    if let Err(err) = update.raw.parse::<toml::Table>() {
        let (line, column) = err
            .span()
            .map(|span| position(&update.raw, span.start))
            .unwrap_or((1, 1));

        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ConfigRejected {
                error: "invalid_toml",
                detail: err.message().to_string(),
                line,
                column,
            }),
        )
            .into_response();
    }

    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            return ApiError::Internal(err.to_string()).into_response();
        }
    }

    match write_atomically(&path, &update.raw) {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "path": path.display().to_string() })),
        )
            .into_response(),
        Err(err) => ApiError::Internal(err.to_string()).into_response(),
    }
}

/// A settings file half-written by a crash is worse than one not written.
fn write_atomically(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    let temp = path.with_extension("toml.new");
    std::fs::write(&temp, contents)?;
    std::fs::rename(&temp, path)
}

fn position(text: &str, offset: usize) -> (usize, usize) {
    let head = &text[..offset.min(text.len())];
    let line = head.matches('\n').count() + 1;
    let column = head.rsplit('\n').next().map(str::len).unwrap_or(0) + 1;
    (line, column)
}
