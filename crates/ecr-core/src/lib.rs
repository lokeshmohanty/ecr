pub mod account;
pub mod compose;
pub mod doctor;
pub mod message;
pub mod revision;

pub use account::{Account, AccountId, Folder};
pub use compose::Draft;
pub use doctor::{Check, CheckStatus, ConfigKind, ConfigSource, Doctor, ResolvedConfig, ToolInfo};
pub use message::{
    Address, Body, BodyFormat, Disposition, Message, MessageId, Part, PartId, PartMeta, Query,
    SyncReport, TagOp, Thread, ThreadId, ThreadSummary,
};
pub use revision::Revision;
