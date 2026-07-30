pub mod discovery;
pub mod doctor;
pub mod error;
pub mod notmuch;
pub mod oauth;
pub mod parse;
pub mod paths;
pub mod settings;
pub mod store;
pub mod tools;

pub use error::{Error, Result};
pub use notmuch::Notmuch;
pub use paths::MailPaths;
pub use settings::ServerSettings;
pub use store::{BodyOptions, MailStore, ProgressSink};
