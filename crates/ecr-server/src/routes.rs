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
