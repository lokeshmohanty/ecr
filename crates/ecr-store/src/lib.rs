pub mod discovery;
pub mod doctor;
pub mod error;
pub mod parse;
pub mod paths;
pub mod settings;
pub mod tools;

pub use error::{Error, Result};
pub use paths::MailPaths;
pub use settings::ServerSettings;
