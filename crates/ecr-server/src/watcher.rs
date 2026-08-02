use crate::events::{EventBus, ServerEvent};
use crate::state::AppState;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::time::Duration;
use tokio::sync::mpsc;

const DEBOUNCE: Duration = Duration::from_secs(2);

pub fn spawn(state: AppState) -> anyhow::Result<RecommendedWatcher> {
    let root = state.store.paths().maildir_root.clone();
    let (tx, rx) = mpsc::unbounded_channel();

    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if is_delivery(&event) {
                let _ = tx.send(());
            }
        }
    })?;

    watcher.watch(Path::new(&root), RecursiveMode::Recursive)?;
    tokio::spawn(debounce_loop(state, rx));

    tracing::info!(root = %root.display(), "watching maildir for delivered mail");
    Ok(watcher)
}

fn is_delivery(event: &notify::Event) -> bool {
    use notify::EventKind;

    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) {
        return false;
    }

    event.paths.iter().any(|p| {
        let text = p.to_string_lossy();
        !text.contains("/.notmuch/") && !text.ends_with(".mbsyncstate") && !text.ends_with(".lock")
    })
}

async fn debounce_loop(state: AppState, mut rx: mpsc::UnboundedReceiver<()>) {
    while rx.recv().await.is_some() {
        while let Ok(Some(())) = tokio::time::timeout(DEBOUNCE, rx.recv()).await {}

        if state.read_only {
            tracing::debug!("maildir changed but the server is read-only; not indexing");
            continue;
        }

        match state.store.notmuch().index_new().await {
            Ok(revision) => {
                // A tag write of our own renames the file behind it — notmuch
                // synchronises maildir flags — and that rename arrives here
                // looking exactly like a delivery. The database standing where
                // that write left it is the proof nothing was delivered:
                // `notmuch new` had nothing to add, so it moved no further.
                // Announcing it as new mail would refresh every client's list
                // for the one tag change that happens by itself, taking the
                // row being read out from under the reader.
                if state.own_write(&revision).await {
                    tracing::debug!(%revision, "maildir changed to match our own tag write");
                    continue;
                }

                tracing::info!(%revision, "indexed newly delivered mail");
                state.events.publish(ServerEvent::MailChanged { revision });
            }
            Err(err) => {
                tracing::warn!(%err, "could not index delivered mail");
                publish_error(&state.events, &err.to_string());
            }
        }
    }
}

fn publish_error(bus: &EventBus, detail: &str) {
    bus.publish(ServerEvent::Error {
        detail: detail.to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, EventKind};
    use std::path::PathBuf;

    fn event(kind: EventKind, path: &str) -> notify::Event {
        notify::Event {
            kind,
            paths: vec![PathBuf::from(path)],
            attrs: Default::default(),
        }
    }

    #[test]
    fn a_new_maildir_file_counts_as_a_delivery() {
        assert!(is_delivery(&event(
            EventKind::Create(CreateKind::File),
            "/Mail/main/Inbox/cur/123:2,"
        )));
    }

    #[test]
    fn notmuch_writing_its_own_database_does_not_count() {
        assert!(!is_delivery(&event(
            EventKind::Create(CreateKind::File),
            "/Mail/.notmuch/xapian/postlist.glass"
        )));
    }

    #[test]
    fn mbsync_state_files_do_not_count() {
        assert!(!is_delivery(&event(
            EventKind::Create(CreateKind::File),
            "/Mail/main/Inbox/.mbsyncstate"
        )));
    }

    #[test]
    fn access_events_do_not_count() {
        assert!(!is_delivery(&event(
            EventKind::Access(notify::event::AccessKind::Read),
            "/Mail/main/Inbox/cur/123:2,"
        )));
    }
}
