use crate::models::{Email, Thread};
use std::sync::mpsc::Sender;
use tokio::runtime::Runtime;

#[derive(Debug)]
pub enum Command {
    Search(String),
    SearchThreads(String),
    LoadThreadMessages(String, String),
    GetEmailContent(String),
    Archive(String),
    AddTag(String, String),
    RemoveTag(String, String),
    ToggleTag(String, String),
    Tag {
        message_id: String,
        add: Vec<String>,
        remove: Vec<String>,
    },
    Sync,
    SendEmail(String, crate::models::ComposeDraft),
    Refresh,
}

#[derive(Debug)]
pub enum Event {
    EmailsLoaded(Vec<Email>),
    ThreadsLoaded(Vec<Thread>),
    ThreadMessagesLoaded(String, Vec<Email>),
    EmailContentLoaded {
        id: String,
        plain: String,
        html: String,
        rendered: Option<String>,
        attachments: Vec<crate::models::Attachment>,
    },
    SyncStarted,
    SyncFinished,
    EmailSent,
    Error(String),
}

pub struct Worker {
    cmd_rx: tokio::sync::mpsc::Receiver<Command>,
    event_tx: Sender<Event>,
    ctx: egui::Context,
}

impl Worker {
    pub fn spawn(
        event_tx: Sender<Event>,
        ctx: egui::Context,
    ) -> (tokio::sync::mpsc::Sender<Command>, std::thread::JoinHandle<()>) {
        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel(100);

        let handle = std::thread::spawn(move || {
            let rt = match Runtime::new() {
                Ok(rt) => rt,
                Err(e) => {
                    tracing::error!("Failed to create Tokio runtime: {}", e);
                    return;
                }
            };
            rt.block_on(async {
                let mut worker = Worker {
                    cmd_rx,
                    event_tx,
                    ctx,
                };
                worker.run().await;
            });
        });

        (cmd_tx, handle)
    }

    async fn run(&mut self) {
        use crate::backends::editor::render_html_with_w3m;
        use crate::backends::mbsync;
        use crate::backends::msmtp::MsmtpBackend;
        use crate::backends::notmuch::NotmuchBackend;

        let notmuch = NotmuchBackend::new();
        let msmtp = MsmtpBackend::new();

        while let Some(cmd) = self.cmd_rx.recv().await {
            let start = std::time::Instant::now();
            tracing::info!("Worker processing command: {:?}", cmd);

            match cmd {
                Command::Search(query) => {
                    match notmuch.search(&query, 50).await {
                        Ok(emails) => {
                            tracing::info!(
                                "Search for '{}' returned {} results, took {:?}",
                                query,
                                emails.len(),
                                start.elapsed()
                            );
                            let _ = self.event_tx.send(Event::EmailsLoaded(emails));
                        }
                        Err(e) => {
                            tracing::error!("Search failed for '{}': {}", query, e);
                            let _ = self
                                .event_tx
                                .send(Event::Error(format!("Search failed: {}", e)));
                        }
                    }
                    self.ctx.request_repaint();
                }
                Command::SearchThreads(query) => {
                    match notmuch.search_threads(&query, 50).await {
                        Ok(threads) => {
                            tracing::info!(
                                "Thread search for '{}' returned {} threads, took {:?}",
                                query,
                                threads.len(),
                                start.elapsed()
                            );
                            let _ = self.event_tx.send(Event::ThreadsLoaded(threads));
                        }
                        Err(e) => {
                            tracing::error!("Thread search failed for '{}': {}", query, e);
                            let _ = self
                                .event_tx
                                .send(Event::Error(format!("Thread search failed: {}", e)));
                        }
                    }
                    self.ctx.request_repaint();
                }
                Command::LoadThreadMessages(thread_id, query) => {
                    match notmuch.search(&query, 100).await {
                        Ok(emails) => {
                            tracing::info!(
                                "Loaded {} messages for thread {}, took {:?}",
                                emails.len(),
                                thread_id,
                                start.elapsed()
                            );
                            let _ = self.event_tx.send(Event::ThreadMessagesLoaded(thread_id, emails));
                        }
                        Err(e) => {
                            tracing::error!("Thread messages load failed for '{}': {}", query, e);
                            let _ = self
                                .event_tx
                                .send(Event::Error(format!("Thread messages load failed: {}", e)));
                        }
                    }
                    self.ctx.request_repaint();
                }
                Command::GetEmailContent(id) => {
                    let (plain, html, attachments) = notmuch.get_email_content(&id).await;
                    let rendered = if !html.is_empty() {
                        render_html_with_w3m(&html)
                    } else {
                        None
                    };
                    tracing::info!(
                        "Loading email content for {} took {:?}",
                        id,
                        start.elapsed()
                    );
                    let _ = self.event_tx.send(Event::EmailContentLoaded {
                        id,
                        plain,
                        html,
                        rendered,
                        attachments,
                    });
                    self.ctx.request_repaint();
                }
                Command::Tag {
                    message_id,
                    add,
                    remove,
                } => {
                    let add_refs: Vec<&str> = add.iter().map(|s| s.as_str()).collect();
                    let remove_refs: Vec<&str> = remove.iter().map(|s| s.as_str()).collect();
                    if let Err(e) = notmuch.tag(&message_id, &add_refs, &remove_refs).await {
                        tracing::error!("Tagging failed: {}", e);
                        let _ = self
                            .event_tx
                            .send(Event::Error(format!("Tagging failed: {}", e)));
                    }
                    self.ctx.request_repaint();
                }
                Command::Archive(id) => {
                    if let Err(e) =
                        notmuch.tag(&id, &["archive"], &["inbox", "unread"]).await
                    {
                        tracing::error!("Archive failed: {}", e);
                        let _ = self
                            .event_tx
                            .send(Event::Error(format!("Archive failed: {}", e)));
                    }
                    self.ctx.request_repaint();
                }
                Command::AddTag(id, tag) => {
                    if let Err(e) = notmuch.tag(&id, &[&tag], &[]).await {
                        tracing::error!("Add tag failed: {}", e);
                        let _ = self
                            .event_tx
                            .send(Event::Error(format!("Add tag failed: {}", e)));
                    }
                    self.ctx.request_repaint();
                }
                Command::RemoveTag(id, tag) => {
                    if let Err(e) = notmuch.tag(&id, &[], &[&tag]).await {
                        tracing::error!("Remove tag failed: {}", e);
                        let _ = self
                            .event_tx
                            .send(Event::Error(format!("Remove tag failed: {}", e)));
                    }
                    self.ctx.request_repaint();
                }
                Command::ToggleTag(id, tag) => {
                    if let Err(e) = notmuch.tag(&id, &[&tag], &[]).await {
                        tracing::error!("Toggle tag failed: {}", e);
                        let _ = self
                            .event_tx
                            .send(Event::Error(format!("Toggle tag failed: {}", e)));
                    }
                    self.ctx.request_repaint();
                }
                Command::Sync => {
                    let _ = self.event_tx.send(Event::SyncStarted);
                    self.ctx.request_repaint();
                    if let Err(e) = mbsync::sync_all().await {
                        tracing::error!("Sync failed: {}", e);
                        let _ = self
                            .event_tx
                            .send(Event::Error(format!("Sync failed: {}", e)));
                    } else {
                        tracing::info!("Sync finished successfully in {:?}", start.elapsed());
                        let _ = self.event_tx.send(Event::SyncFinished);
                    }
                    self.ctx.request_repaint();
                }
                Command::SendEmail(account, draft) => {
                    tracing::info!("Sending email via account: {}", account);
                    if let Err(e) = msmtp.send(&account, &draft).await {
                        tracing::error!("Send failed: {}", e);
                        let _ = self
                            .event_tx
                            .send(Event::Error(format!("Send failed: {}", e)));
                    } else {
                        tracing::info!(
                            "Email sent successfully in {:?}",
                            start.elapsed()
                        );
                        let _ = self.event_tx.send(Event::EmailSent);
                    }
                    self.ctx.request_repaint();
                }
                Command::Refresh => {
                    // No-op, UI will re-send Search command
                    self.ctx.request_repaint();
                }
            }
        }
    }
}
