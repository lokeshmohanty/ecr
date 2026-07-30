use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug)]
pub enum ApiError {
    NotFound(String),
    BadRequest(String),
    Unauthorized,
    Unavailable(String),
    Internal(String),
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
    detail: String,
}

impl ApiError {
    fn parts(&self) -> (StatusCode, &'static str, String) {
        match self {
            ApiError::NotFound(detail) => (StatusCode::NOT_FOUND, "not_found", detail.clone()),
            ApiError::BadRequest(detail) => {
                (StatusCode::BAD_REQUEST, "bad_request", detail.clone())
            }
            ApiError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "a valid bearer token is required".to_string(),
            ),
            ApiError::Unavailable(detail) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                detail.clone(),
            ),
            ApiError::Internal(detail) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                detail.clone(),
            ),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, error, detail) = self.parts();
        if status.is_server_error() {
            tracing::error!(%error, %detail, "request failed");
        }
        (
            status,
            Json(ErrorBody {
                error: error.to_string(),
                detail,
            }),
        )
            .into_response()
    }
}

impl From<ecr_store::Error> for ApiError {
    fn from(err: ecr_store::Error) -> Self {
        use ecr_store::Error as E;
        match &err {
            E::MessageNotFound { .. } | E::PartNotFound { .. } => {
                ApiError::NotFound(err.to_string())
            }
            E::InvalidTag { .. } | E::UnknownSendAccount { .. } => {
                ApiError::BadRequest(err.to_string())
            }
            E::ToolMissing { .. }
            | E::ConfigNotFound { .. }
            | E::MaildirMissing { .. }
            | E::NoDatabasePath { .. } => ApiError::Unavailable(err.to_string()),
            _ => ApiError::Internal(err.to_string()),
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;

    fn status_of(err: ecr_store::Error) -> StatusCode {
        ApiError::from(err).parts().0
    }

    #[test]
    fn a_missing_message_is_a_404() {
        assert_eq!(
            status_of(ecr_store::Error::MessageNotFound {
                id: "x".to_string()
            }),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn an_invalid_tag_is_a_400_not_a_500() {
        assert_eq!(
            status_of(ecr_store::Error::InvalidTag {
                tag: "bad\n".to_string(),
                reason: "no newlines"
            }),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn a_missing_tool_is_a_503_because_it_is_an_environment_problem() {
        assert_eq!(
            status_of(ecr_store::Error::ToolMissing { tool: "notmuch" }),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[test]
    fn an_unexpected_tool_failure_is_a_500() {
        assert_eq!(
            status_of(ecr_store::Error::ToolFailed {
                tool: "notmuch",
                stderr: "boom".to_string()
            }),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn unauthorized_does_not_leak_detail() {
        let (status, error, detail) = ApiError::Unauthorized.parts();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(error, "unauthorized");
        assert!(!detail.contains("token="), "{detail}");
    }
}
