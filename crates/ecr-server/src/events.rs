use ecr_core::revision::Revision;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

const CHANNEL_CAPACITY: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    MailChanged {
        revision: Revision,
    },
    TagsChanged {
        revision: Revision,
        ids: Vec<String>,
    },
    SyncStarted {
        accounts: Vec<String>,
    },
    SyncProgress {
        line: String,
    },
    SyncFinished {
        new_messages: usize,
        revision: Revision,
    },
    Error {
        detail: String,
    },
}

impl ServerEvent {
    pub fn name(&self) -> &'static str {
        match self {
            ServerEvent::MailChanged { .. } => "mail:changed",
            ServerEvent::TagsChanged { .. } => "tags:changed",
            ServerEvent::SyncStarted { .. } => "sync:started",
            ServerEvent::SyncProgress { .. } => "sync:progress",
            ServerEvent::SyncFinished { .. } => "sync:finished",
            ServerEvent::Error { .. } => "error",
        }
    }
}

#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<ServerEvent>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(CHANNEL_CAPACITY);
        Self { sender }
    }

    pub fn publish(&self, event: ServerEvent) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.sender.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }
}

pub struct SyncProgress {
    bus: EventBus,
}

impl SyncProgress {
    pub fn new(bus: EventBus) -> Self {
        Self { bus }
    }
}

impl ecr_store::ProgressSink for SyncProgress {
    fn line(&self, text: &str) {
        self.bus.publish(ServerEvent::SyncProgress {
            line: text.to_string(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn revision() -> Revision {
        Revision::new("uuid", 1)
    }

    #[test]
    fn events_carry_stable_wire_names() {
        assert_eq!(
            ServerEvent::MailChanged {
                revision: revision()
            }
            .name(),
            "mail:changed"
        );
        assert_eq!(
            ServerEvent::SyncFinished {
                new_messages: 0,
                revision: revision()
            }
            .name(),
            "sync:finished"
        );
    }

    #[test]
    fn events_serialize_with_a_discriminating_type_field() {
        let json = serde_json::to_string(&ServerEvent::MailChanged {
            revision: revision(),
        })
        .unwrap();

        assert!(json.contains(r#""type":"mail_changed""#), "{json}");
        assert!(json.contains(r#""lastmod":1"#), "{json}");
    }

    #[tokio::test]
    async fn subscribers_receive_published_events() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        bus.publish(ServerEvent::MailChanged {
            revision: revision(),
        });

        let received = rx.recv().await.unwrap();
        assert_eq!(
            received,
            ServerEvent::MailChanged {
                revision: revision()
            }
        );
    }

    #[tokio::test]
    async fn publishing_with_no_subscribers_does_not_fail() {
        let bus = EventBus::new();
        bus.publish(ServerEvent::Error {
            detail: "nobody listening".to_string(),
        });
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[tokio::test]
    async fn every_subscriber_sees_the_same_event() {
        let bus = EventBus::new();
        let mut a = bus.subscribe();
        let mut b = bus.subscribe();

        bus.publish(ServerEvent::SyncStarted {
            accounts: vec!["main".to_string()],
        });

        assert_eq!(a.recv().await.unwrap(), b.recv().await.unwrap());
    }

    #[tokio::test]
    async fn the_progress_sink_publishes_each_line() {
        use ecr_store::ProgressSink;

        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        let sink = SyncProgress::new(bus.clone());

        sink.line("C: 1/2");

        assert_eq!(
            rx.recv().await.unwrap(),
            ServerEvent::SyncProgress {
                line: "C: 1/2".to_string()
            }
        );
    }
}
