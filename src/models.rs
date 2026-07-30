use crate::backends::msmtp::MsmtpBackend;
use crate::backends::notmuch::NotmuchBackend;
use crate::config::Config;
use crate::keybindings::{Action as KbAction, KeybindingEngine};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;

// ── Mode for Vim-like interaction ──────────────────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VimMode {
    Normal,
    Insert,
    Command,
    Search,
}

impl fmt::Display for VimMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            VimMode::Normal => "NORMAL",
            VimMode::Insert => "INSERT",
            VimMode::Command => "COMMAND",
            VimMode::Search => "SEARCH",
        };
        write!(f, "{}", s)
    }
}

// ── Mark types (not executed until user triggers) ──────────────────────
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Mark {
    Archive,
    Delete,
    Tag(String),
    UnTag(String),
    Read,
    Unread,
    Flag,
    Unflag,
}

impl Mark {
    pub fn badge_label(&self) -> &str {
        match self {
            Mark::Archive => "ARCHIVE",
            Mark::Delete => "DELETE",
            Mark::Tag(_) => "+TAG",
            Mark::UnTag(_) => "-TAG",
            Mark::Read => "READ",
            Mark::Unread => "UNREAD",
            Mark::Flag => "FLAG",
            Mark::Unflag => "UNFLAG",
        }
    }
}

// ── Mark queue: message_id → Vec<Mark> ─────────────────────────────────
#[derive(Debug, Clone, Default)]
pub struct MarkQueue {
    pub marks: HashMap<String, Vec<Mark>>,
}

impl MarkQueue {
    pub fn new() -> Self {
        Self {
            marks: HashMap::new(),
        }
    }

    pub fn add(&mut self, message_id: &str, mark: Mark) {
        self.marks
            .entry(message_id.to_string())
            .or_default()
            .push(mark);
    }

    pub fn remove(&mut self, message_id: &str) {
        self.marks.remove(message_id);
    }

    pub fn get(&self, message_id: &str) -> Option<&Vec<Mark>> {
        self.marks.get(message_id)
    }

    pub fn is_empty(&self) -> bool {
        self.marks.is_empty()
    }

    pub fn len(&self) -> usize {
        self.marks.len()
    }

    pub fn clear(&mut self) {
        self.marks.clear();
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Vec<Mark>)> {
        self.marks.iter()
    }
}

// ── Query-centric View (replaces folder/mailbox concept) ───────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct View {
    pub name: String,
    pub query: String,
    pub icon: String,
    pub unread_count: usize,
}

impl View {
    pub fn new(name: &str, query: &str) -> Self {
        let icon = match name.to_lowercase().as_str() {
            "inbox" => "📥",
            "unread" => "✉",
            "today" => "📅",
            "flagged" => "★",
            "sent" => "📧",
            "drafts" => "📝",
            "archive" => "📦",
            "trash" => "🗑",
            "spam" => "🚫",
            _ => "📂",
        };
        Self {
            name: name.to_string(),
            query: query.to_string(),
            icon: icon.to_string(),
            unread_count: 0,
        }
    }
}

// ── Thread model (first-class entity from notmuch) ─────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thread {
    pub thread_id: String,
    pub subject: String,
    pub authors: String,
    pub date: String,
    pub tags: HashSet<String>,
    pub message_count: usize,
    pub matched_messages: usize,
    pub messages: Vec<Email>,
    pub has_newest: bool,
}

impl Thread {
    pub fn new(
        thread_id: String,
        subject: String,
        authors: String,
        date: String,
        tags: HashSet<String>,
        message_count: usize,
        matched_messages: usize,
    ) -> Self {
        Self {
            thread_id,
            subject,
            authors,
            date,
            tags,
            message_count,
            matched_messages,
            messages: Vec::new(),
            has_newest: true,
        }
    }

    pub fn is_unread(&self) -> bool {
        self.tags.contains("unread")
    }

    pub fn is_flagged(&self) -> bool {
        self.tags.contains("flagged") || self.tags.contains("starred")
    }
}

// ── Folding state for threads ──────────────────────────────────────────
#[derive(Debug, Clone, Default)]
pub struct FoldState {
    collapsed: HashSet<String>,
}

impl FoldState {
    pub fn new() -> Self {
        Self {
            collapsed: HashSet::new(),
        }
    }

    pub fn is_collapsed(&self, thread_id: &str) -> bool {
        self.collapsed.contains(thread_id)
    }

    pub fn toggle(&mut self, thread_id: String) {
        if self.collapsed.contains(&thread_id) {
            self.collapsed.remove(&thread_id);
        } else {
            self.collapsed.insert(thread_id);
        }
    }

    pub fn collapse(&mut self, thread_id: String) {
        self.collapsed.insert(thread_id);
    }

    pub fn expand(&mut self, thread_id: String) {
        self.collapsed.remove(&thread_id);
    }

    pub fn expand_all(&mut self) {
        self.collapsed.clear();
    }

    pub fn collapse_all(&mut self, thread_ids: &[String]) {
        self.collapsed.clear();
        for id in thread_ids {
            self.collapsed.insert(id.clone());
        }
    }
}

// ── Pane layout ────────────────────────────────────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Pane {
    Sidebar,
    EmailList,
    ReadingPane,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RightPane {
    EmailDetail,
    Compose,
    Config,
}

// ── Data models ────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub filename: String,
    pub content_type: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Email {
    pub id: usize,
    pub message_id: String,
    pub thread_id: String,
    pub sender_name: String,
    pub sender_email: String,
    pub subject: String,
    pub date: String,
    pub time: String,
    pub body: String,
    pub html_body: String,
    pub rendered_html: Option<String>,
    pub tags: HashSet<String>,
    pub read: bool,
    pub flagged: bool,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub name: String,
    pub email: String,
    pub msmtp_account: String,
    pub notmuch_tag_prefix: String,
    pub maildir_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposeDraft {
    pub to: String,
    pub cc: String,
    pub bcc: String,
    pub subject: String,
    pub body: String,
    pub in_reply_to: Option<usize>,
}

impl ComposeDraft {
    pub fn empty() -> Self {
        Self {
            to: String::new(),
            cc: String::new(),
            bcc: String::new(),
            subject: String::new(),
            body: String::new(),
            in_reply_to: None,
        }
    }
}

// ── Default views (query-centric, not folder-centric) ──────────────────
pub fn default_views() -> Vec<View> {
    vec![
        View::new("Inbox", "tag:inbox"),
        View::new("Unread", "tag:unread"),
        View::new("Today", "date:today"),
        View::new("Flagged", "tag:flagged"),
        View::new("Sent", "tag:sent"),
        View::new("Drafts", "tag:draft"),
        View::new("Archive", "tag:archive"),
    ]
}

#[derive(Copy, Clone)]
pub enum Row<'a> {
    Thread(&'a Thread),
    Email(&'a Thread, &'a Email),
}

// ── AppState ───────────────────────────────────────────────────────────
pub struct AppState {
    pub config: Config,
    pub mode: VimMode,

    // Query-centric views (not mailboxes/folders)
    pub views: Vec<View>,
    pub selected_view_idx: usize,

    // Thread-based data
    pub threads: Vec<Thread>,
    // Only keeping selected_row_index, representing index in flattened visible rows
    pub selected_row_index: Option<usize>,
    pub fold_state: FoldState,

    // Flat email list (for non-threaded fallback, though primarily using threads now)
    pub emails: Vec<Email>,

    // Mark queue (mark now, execute later)
    pub mark_queue: MarkQueue,

    // UI state
    pub command_buffer: String,
    pub search_query: String,
    pub status_message: String,
    pub scroll_to_selected: bool,
    pub focus_input: bool,
    pub total_emails: usize,
    pub right_pane: RightPane,
    pub render_html: bool,
    pub compose_draft: ComposeDraft,
    pub show_tag_input: bool,
    pub tag_input: String,
    pub next_email_id: usize,
    pub current_pane: Pane,

    // Accounts
    pub accounts: Vec<Account>,
    pub selected_account_idx: usize,

    // Backends
    pub notmuch: NotmuchBackend,
    pub msmtp: MsmtpBackend,

    // Channels
    pub cmd_tx: tokio::sync::mpsc::Sender<crate::worker::Command>,
    pub event_rx: std::sync::mpsc::Receiver<crate::worker::Event>,

    // Keybinding Engine
    pub kb_engine: KeybindingEngine,
}

impl AppState {
    pub fn new(
        cmd_tx: tokio::sync::mpsc::Sender<crate::worker::Command>,
        event_rx: std::sync::mpsc::Receiver<crate::worker::Event>,
    ) -> Self {
        let config = Config::load();
        let notmuch = NotmuchBackend::new();
        let msmtp = MsmtpBackend::new();

        use crate::backends::mbsync;
        let accounts_info = mbsync::get_accounts();
        let mut accounts: Vec<Account> = accounts_info
            .iter()
            .map(|info| Account {
                name: info.name.clone(),
                email: info.email.clone(),
                msmtp_account: info.email.clone(),
                notmuch_tag_prefix: info.email.clone(),
                maildir_path: info.maildir_path.clone(),
            })
            .collect();

        if accounts.is_empty() {
            accounts.push(Account {
                name: "default".to_string(),
                email: "default@example.com".to_string(),
                msmtp_account: "default".to_string(),
                notmuch_tag_prefix: "".to_string(),
                maildir_path: "".to_string(),
            });
        }

        // Query-centric views instead of mailboxes
        let views = default_views();

        let mut kb_engine = KeybindingEngine::new();
        kb_engine.add_binding(&config.keybindings.normal.next_email, KbAction::NextEmail);
        kb_engine.add_binding(&config.keybindings.normal.prev_email, KbAction::PrevEmail);
        kb_engine.add_binding(&config.keybindings.normal.pane_left, KbAction::PaneLeft);
        kb_engine.add_binding(&config.keybindings.normal.pane_right, KbAction::PaneRight);
        kb_engine.add_binding(&config.keybindings.normal.search, KbAction::Search);
        kb_engine.add_binding(
            &config.keybindings.normal.command_mode,
            KbAction::CommandMode,
        );
        kb_engine.add_binding(&config.keybindings.normal.compose, KbAction::Compose);
        kb_engine.add_binding(&config.keybindings.normal.reply, KbAction::Reply);
        kb_engine.add_binding(&config.keybindings.normal.star, KbAction::Star);
        kb_engine.add_binding(&config.keybindings.normal.toggle_read, KbAction::ToggleRead);
        kb_engine.add_binding(&config.keybindings.normal.archive, KbAction::Archive);
        kb_engine.add_binding(
            &config.keybindings.normal.delete_archive,
            KbAction::DeleteArchive,
        );
        kb_engine.add_binding(&config.keybindings.normal.execute, KbAction::Execute);
        kb_engine.add_special_binding("g", KbAction::FirstEmail);

        for (sequence, result) in &config.macros {
            kb_engine.add_macro(sequence, result);
        }

        Self {
            config,
            mode: VimMode::Normal,
            views,
            selected_view_idx: 0,
            threads: Vec::new(),
            selected_row_index: None,
            fold_state: FoldState::new(),
            emails: Vec::new(),
            mark_queue: MarkQueue::new(),
            command_buffer: String::new(),
            search_query: String::new(),
            status_message: String::new(),
            scroll_to_selected: false,
            focus_input: false,
            total_emails: 0,
            right_pane: RightPane::EmailDetail,
            render_html: true,
            compose_draft: ComposeDraft::empty(),
            show_tag_input: false,
            tag_input: String::new(),
            next_email_id: 100,
            current_pane: Pane::EmailList,
            accounts,
            selected_account_idx: 0,
            notmuch,
            msmtp,
            cmd_tx,
            event_rx,
            kb_engine,
        }
    }

    // ── Query-centric view switching ───────────────────────────────────
    pub fn switch_to_view(&mut self, idx: usize) {
        if idx < self.views.len() {
            let query = self.views[idx].query.clone();
            let view_name = self.views[idx].name.clone();
            self.selected_view_idx = idx;
            // Stateless refresh: re-run query, discard old state
            self.clear_marks();
            // Threads are first class -> SearchThreads
            let _ = self.cmd_tx.try_send(crate::worker::Command::SearchThreads(query));
            self.status_message = format!("View: {}", view_name);
        }
    }

    pub fn current_view(&self) -> Option<&View> {
        self.views.get(self.selected_view_idx)
    }

    // ── Mark queue operations ──────────────────────────────────────────
    pub fn mark_email(&mut self, message_id: &str, mark: Mark) {
        let label = match &mark {
            Mark::Archive => "ARCHIVE",
            Mark::Delete => "DELETE",
            Mark::Tag(_) => "+TAG",
            Mark::UnTag(_) => "-TAG",
            Mark::Read => "READ",
            Mark::Unread => "UNREAD",
            Mark::Flag => "FLAG",
            Mark::Unflag => "UNFLAG",
        };
        self.mark_queue.add(message_id, mark);
        self.status_message = format!(
            "Marked {} [{}]",
            message_id.chars().take(12).collect::<String>(),
            label
        );
    }

    pub fn unmark_email(&mut self, message_id: &str) {
        self.mark_queue.remove(message_id);
    }

    pub fn clear_marks(&mut self) {
        self.mark_queue.clear();
    }

    pub fn has_mark(&self, message_id: &str) -> Option<&Vec<Mark>> {
        self.mark_queue.get(message_id)
    }

    // ── Execute all queued marks ───────────────────────────────────────
    pub fn execute_marks(&mut self) {
        if self.mark_queue.is_empty() {
            self.status_message = "No marks to execute".into();
            return;
        }

        let count = self.mark_queue.len();
        let marks: Vec<_> = self
            .mark_queue
            .iter()
            .map(|(id, m)| (id.clone(), m.clone()))
            .collect();

        for (target_id, marks) in marks {
            for mark in &marks {
                // Determine if ID is thread or message
                let is_thread = target_id.starts_with("thread:");
                
                let cmd = match mark {
                    Mark::Archive => {
                        if is_thread {
                            crate::worker::Command::Tag {
                                message_id: target_id.clone(),
                                add: vec!["archive".to_string()],
                                remove: vec!["inbox".to_string(), "unread".to_string()],
                            }
                        } else {
                            crate::worker::Command::Archive(target_id.clone())
                        }
                    }
                    Mark::Delete => crate::worker::Command::Tag {
                        message_id: target_id.clone(),
                        add: vec!["trash".to_string()],
                        remove: vec!["inbox".to_string(), "unread".to_string()],
                    },
                    Mark::Tag(t) => crate::worker::Command::AddTag(target_id.clone(), t.clone()),
                    Mark::UnTag(t) => {
                        crate::worker::Command::RemoveTag(target_id.clone(), t.clone())
                    }
                    Mark::Read => {
                        crate::worker::Command::RemoveTag(target_id.clone(), "unread".to_string())
                    }
                    Mark::Unread => {
                        crate::worker::Command::AddTag(target_id.clone(), "unread".to_string())
                    }
                    Mark::Flag => {
                        crate::worker::Command::AddTag(target_id.clone(), "flagged".to_string())
                    }
                    Mark::Unflag => {
                        crate::worker::Command::RemoveTag(target_id.clone(), "flagged".to_string())
                    }
                };
                let _ = self.cmd_tx.try_send(cmd);
            }
        }

        self.mark_queue.clear();
        self.status_message = format!("Executed {} mark(s)", count);
        // Stateless refresh after execution
        self.refresh_current_view();
    }

    // ── Stateless refresh: re-run current query ────────────────────────
    pub fn refresh_current_view(&mut self) {
        if let Some(view) = self.current_view() {
            let query = view.query.clone();
            self.clear_marks();
            let _ = self.cmd_tx.try_send(crate::worker::Command::SearchThreads(query));
            self.status_message = "Refreshed".into();
        }
    }

    // ── Row flattening ──────────────────────────────────────────────────
    pub fn visible_rows(&self) -> Vec<Row<'_>> {
        let mut rows = Vec::new();
        // Default to threading behavior unless search query is populated and we fallback?
        // Let's use threads all the time for thread-first semantics
        let q = self.search_query.to_lowercase();
        for thread in &self.threads {
            if !q.is_empty() {
                if !thread.subject.to_lowercase().contains(&q)
                    && !thread.authors.to_lowercase().contains(&q)
                    && !thread.tags.iter().any(|t| t.to_lowercase().contains(&q))
                {
                    continue;
                }
            }
            
            rows.push(Row::Thread(thread));
            if !self.fold_state.is_collapsed(&thread.thread_id) {
                // If it's expanded, add all messages
                for email in &thread.messages {
                    rows.push(Row::Email(thread, email));
                }
            }
        }
        
        // Fallback: If threads is empty but emails is not (e.g. basic search fallback),
        // we essentially treat them as flat messages not attached to a thread, or we ignore them.
        // For strict thread-first, we only render threads.
        
        rows
    }

    pub fn selected_row(&self) -> Option<Row<'_>> {
        let rows = self.visible_rows();
        if let Some(idx) = self.selected_row_index {
            rows.get(idx).copied()
        } else {
            None
        }
    }

    // ── Body loading ───────────────────────────────────────────────────
    pub fn load_body_if_needed(&mut self) {
        if let Some(Row::Email(_, email)) = self.selected_row() {
            if email.body.is_empty() && email.html_body.is_empty() {
                let _ = self.cmd_tx.try_send(crate::worker::Command::GetEmailContent(
                    email.message_id.clone(),
                ));
            }
        }
    }

    // ── Send draft ─────────────────────────────────────────────────────
    pub fn send_draft(&mut self) {
        let account = if let Some(acc) = self.current_account() {
            acc.msmtp_account.clone()
        } else {
            "default".to_string()
        };

        let _ = self.cmd_tx.try_send(crate::worker::Command::SendEmail(
            account,
            self.compose_draft.clone(),
        ));
        self.status_message = "Sending email...".into();
    }

    // ── Filtering ──────────────────────────────────────────────────────
    pub fn filtered_indices(&self) -> Vec<usize> {
        (0..self.visible_rows().len()).collect()
    }

    pub fn current_account(&self) -> Option<&Account> {
        self.accounts.get(self.selected_account_idx)
    }

    // ── Pane navigation ────────────────────────────────────────────────
    pub fn move_pane_left(&mut self) {
        match self.current_pane {
            Pane::ReadingPane => self.current_pane = Pane::EmailList,
            Pane::EmailList => self.current_pane = Pane::Sidebar,
            Pane::Sidebar => {}
        }
    }

    pub fn move_pane_right(&mut self) {
        match self.current_pane {
            Pane::Sidebar => self.current_pane = Pane::EmailList,
            Pane::EmailList => self.current_pane = Pane::ReadingPane,
            Pane::ReadingPane => {}
        }
    }

    // ── Navigation (row-aware) ─────────────────────────────────────────
    pub fn select_next_email(&mut self) {
        match self.current_pane {
            Pane::Sidebar => {
                if self.selected_view_idx + 1 < self.views.len() {
                    self.switch_to_view(self.selected_view_idx + 1);
                }
            }
            Pane::EmailList => {
                let count = self.visible_rows().len();
                if let Some(idx) = self.selected_row_index {
                    if idx + 1 < count {
                        self.selected_row_index = Some(idx + 1);
                        self.scroll_to_selected = true;
                    }
                } else if count > 0 {
                    self.selected_row_index = Some(0);
                    self.scroll_to_selected = true;
                }
            }
            _ => {}
        }
    }

    pub fn select_prev_email(&mut self) {
        match self.current_pane {
            Pane::Sidebar => {
                if self.selected_view_idx > 0 {
                    self.switch_to_view(self.selected_view_idx - 1);
                }
            }
            Pane::EmailList => {
                let count = self.visible_rows().len();
                if let Some(idx) = self.selected_row_index {
                    if idx > 0 {
                        self.selected_row_index = Some(idx - 1);
                        self.scroll_to_selected = true;
                    }
                } else if count > 0 {
                    self.selected_row_index = Some(count - 1);
                    self.scroll_to_selected = true;
                }
            }
            _ => {}
        }
    }

    pub fn select_first_email(&mut self) {
        if !self.visible_rows().is_empty() {
            self.selected_row_index = Some(0);
            self.scroll_to_selected = true;
        }
    }

    pub fn select_last_email(&mut self) {
        let count = self.visible_rows().len();
        if count > 0 {
            self.selected_row_index = Some(count - 1);
            self.scroll_to_selected = true;
        }
    }

    pub fn open_selected_email(&mut self) {
        let mut toggle_tid = None;
        let mut load_tid = None;
        let mut open_email = false;

        if let Some(row) = self.selected_row() {
            match row {
                Row::Thread(thread) => {
                    let tid = thread.thread_id.clone();
                    toggle_tid = Some(tid.clone());
                    
                    let will_expand = self.fold_state.is_collapsed(&tid);
                    if will_expand && thread.messages.is_empty() {
                        load_tid = Some(tid);
                    }
                }
                Row::Email(_, _) => {
                    open_email = true;
                }
            }
        }

        if let Some(tid) = toggle_tid {
            self.fold_state.toggle(tid);
            self.scroll_to_selected = true;
        }

        if let Some(tid) = load_tid {
            let q = format!("thread:{}", tid);
            let _ = self.cmd_tx.try_send(crate::worker::Command::LoadThreadMessages(tid, q));
            self.status_message = "Loading thread messages...".into();
        }

        if open_email {
            self.right_pane = RightPane::EmailDetail;
            if !self.is_selected_read() {
                self.mark_read_on_selected();
            }
        }
    }

    pub fn is_selected_read(&self) -> bool {
        if let Some(Row::Email(_, email)) = self.selected_row() {
            return email.read;
        }
        true // Threads shouldn't show unread bolding immediately here unless calculated differently
    }

    // ── Actions (mark-based, not immediate) ────────────────────────────
    pub fn target_id_for_selected(&self) -> Option<String> {
        match self.selected_row() {
            Some(Row::Thread(t)) => Some(format!("thread:{}", t.thread_id)),
            Some(Row::Email(_, e)) => Some(e.message_id.clone()),
            None => None,
        }
    }

    pub fn archive_selected(&mut self) {
        if let Some(id) = self.target_id_for_selected() {
            self.mark_email(&id, Mark::Archive);
        }
    }

    pub fn delete_selected(&mut self) {
        if let Some(id) = self.target_id_for_selected() {
            self.mark_email(&id, Mark::Delete);
        }
    }

    pub fn toggle_star(&mut self) {
        if let Some(row) = self.selected_row() {
            let (mid, is_flagged) = match row {
                Row::Email(_, e) => (e.message_id.clone(), e.flagged),
                Row::Thread(t) => (format!("thread:{}", t.thread_id), t.is_flagged()),
            };
            if is_flagged {
                self.mark_email(&mid, Mark::Unflag);
            } else {
                self.mark_email(&mid, Mark::Flag);
            }
        }
    }

    pub fn mark_read_on_selected(&mut self) {
        if let Some(id) = self.target_id_for_selected() {
            self.mark_email(&id, Mark::Read);
        }
    }

    pub fn toggle_read(&mut self) {
        if let Some(row) = self.selected_row() {
            let (mid, is_read) = match row {
                Row::Email(_, e) => (e.message_id.clone(), e.read),
                Row::Thread(t) => (format!("thread:{}", t.thread_id), !t.is_unread()),
            };
            if is_read {
                self.mark_email(&mid, Mark::Unread);
            } else {
                self.mark_email(&mid, Mark::Read);
            }
        }
    }

    // ── Compose ────────────────────────────────────────────────────────
    pub fn start_compose(&mut self) {
        self.compose_draft = ComposeDraft::empty();
        self.right_pane = RightPane::Compose;
        self.mode = VimMode::Insert;
    }

    pub fn start_reply(&mut self) {
        if let Some(Row::Email(_, email)) = self.selected_row() {
            self.compose_draft = ComposeDraft {
                to: email.sender_email.clone(),
                cc: String::new(),
                bcc: String::new(),
                subject: format!("Re: {}", email.subject),
                body: format!(
                    "\n\nOn {}, {} wrote:\n> {}",
                    email.date,
                    email.sender_name,
                    email.body.replace('\n', "\n> ")
                ),
                in_reply_to: Some(email.id),
            };
            self.right_pane = RightPane::Compose;
            self.mode = VimMode::Insert;
        }
    }

    pub fn start_forward(&mut self) {
        if let Some(Row::Email(_, email)) = self.selected_row() {
            self.compose_draft = ComposeDraft {
                to: String::new(),
                cc: String::new(),
                bcc: String::new(),
                subject: format!("Fwd: {}", email.subject),
                body: format!(
                    "\n\n---------- Forwarded message ----------\nFrom: {} <{}>\nDate: {}\nSubject: {}\n\n{}",
                    email.sender_name, email.sender_email, email.date, email.subject, email.body
                ),
                in_reply_to: None,
            };
            self.right_pane = RightPane::Compose;
            self.mode = VimMode::Insert;
        }
    }

    pub fn discard_draft(&mut self) {
        self.right_pane = RightPane::EmailDetail;
        self.mode = VimMode::Normal;
        self.status_message = "Draft discarded".into();
    }

    // ── Account switching ──────────────────────────────────────────────
    pub fn switch_to_account(&mut self, idx: usize) {
        if idx < self.accounts.len() {
            let account_name = self.accounts[idx].name.clone();
            self.selected_account_idx = idx;
            self.status_message = format!("Switched to account: {}", account_name);
            // Refresh current view for new account
            self.refresh_current_view();
        }
    }

    pub fn switch_to_next_account(&mut self) {
        if !self.accounts.is_empty() {
            let next = (self.selected_account_idx + 1) % self.accounts.len();
            self.switch_to_account(next);
        }
    }

    pub fn switch_to_prev_account(&mut self) {
        if !self.accounts.is_empty() {
            let prev = if self.selected_account_idx > 0 {
                self.selected_account_idx - 1
            } else {
                self.accounts.len() - 1
            };
            self.switch_to_account(prev);
        }
    }

    // ── Tag operations ─────────────────────────────────────────────────
    pub fn add_tag_to_selected(&mut self, tag: &str) {
        if let Some(id) = self.target_id_for_selected() {
            self.mark_email(&id, Mark::Tag(tag.to_string()));
        }
    }

    pub fn remove_tag_from_selected(&mut self, tag: &str) {
        if let Some(id) = self.target_id_for_selected() {
            self.mark_email(&id, Mark::UnTag(tag.to_string()));
        }
    }

    pub fn apply_search(&mut self) {
        if !self.search_query.is_empty() {
            self.clear_marks();
            std::mem::drop(
                self.cmd_tx
                    .send(crate::worker::Command::Search(self.search_query.clone())),
            );
        }
    }

    // ── Counts ─────────────────────────────────────────────────────────
    pub fn unread_count(&self) -> usize {
        self.emails
            .iter()
            .filter(|e| e.tags.iter().any(|t| t == "unread"))
            .count()
    }

    pub fn tag_count(&self, tag: &str) -> usize {
        self.emails
            .iter()
            .filter(|e| {
                e.tags
                    .iter()
                    .any(|t| t.to_lowercase() == tag.to_lowercase())
            })
            .count()
    }

    pub fn current_line(&self) -> usize {
        self.selected_row_index.map(|i| i + 1).unwrap_or(0)
    }

    pub fn auto_save_draft(&self) {
        if !self.compose_draft.body.is_empty() {
            let path = std::env::temp_dir().join("ecr_autosave_draft.json");
            if let Ok(json) = serde_json::to_string_pretty(&self.compose_draft) {
                let _ = std::fs::write(path, json);
            }
        }
    }
}

pub fn mock_emails() -> Vec<Email> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Mark tests ─────────────────────────────────────────────────
    #[test]
    fn test_mark_badge_labels() {
        assert_eq!(Mark::Archive.badge_label(), "ARCHIVE");
        assert_eq!(Mark::Delete.badge_label(), "DELETE");
        assert_eq!(Mark::Read.badge_label(), "READ");
        assert_eq!(Mark::Unread.badge_label(), "UNREAD");
        assert_eq!(Mark::Flag.badge_label(), "FLAG");
        assert_eq!(Mark::Unflag.badge_label(), "UNFLAG");
        assert_eq!(Mark::Tag("foo".into()).badge_label(), "+TAG");
        assert_eq!(Mark::UnTag("bar".into()).badge_label(), "-TAG");
    }

    // ── MarkQueue tests ────────────────────────────────────────────
    #[test]
    fn test_mark_queue_add_and_get() {
        let mut mq = MarkQueue::new();
        mq.add("msg1", Mark::Archive);
        mq.add("msg1", Mark::Read);
        mq.add("msg2", Mark::Delete);

        assert_eq!(mq.len(), 2);
        assert!(!mq.is_empty());

        let marks = mq.get("msg1").unwrap();
        assert_eq!(marks.len(), 2);
        assert_eq!(marks[0].badge_label(), "ARCHIVE");
        assert_eq!(marks[1].badge_label(), "READ");
    }

    #[test]
    fn test_mark_queue_remove() {
        let mut mq = MarkQueue::new();
        mq.add("msg1", Mark::Archive);
        assert_eq!(mq.len(), 1);
        mq.remove("msg1");
        assert!(mq.is_empty());
        assert!(mq.get("msg1").is_none());
    }

    #[test]
    fn test_mark_queue_clear() {
        let mut mq = MarkQueue::new();
        mq.add("msg1", Mark::Archive);
        mq.add("msg2", Mark::Delete);
        assert_eq!(mq.len(), 2);
        mq.clear();
        assert!(mq.is_empty());
    }

    #[test]
    fn test_mark_queue_iter() {
        let mut mq = MarkQueue::new();
        mq.add("a", Mark::Archive);
        mq.add("b", Mark::Delete);
        let count: usize = mq.iter().map(|(_, m)| m.len()).sum();
        assert_eq!(count, 2);
    }

    // ── View tests ─────────────────────────────────────────────────
    #[test]
    fn test_view_creation() {
        let v = View::new("Inbox", "tag:inbox");
        assert_eq!(v.name, "Inbox");
        assert_eq!(v.query, "tag:inbox");
        assert_eq!(v.icon, "📥");
    }

    #[test]
    fn test_view_unknown_icon() {
        let v = View::new("Custom", "tag:custom");
        assert_eq!(v.icon, "📂");
    }

    #[test]
    fn test_default_views() {
        let views = default_views();
        assert!(!views.is_empty());
        assert_eq!(views[0].name, "Inbox");
        assert_eq!(views[0].query, "tag:inbox");
        assert_eq!(views[1].name, "Unread");
        assert_eq!(views[1].query, "tag:unread");
        assert_eq!(views[2].name, "Today");
        assert_eq!(views[2].query, "date:today");
    }

    // ── FoldState tests ────────────────────────────────────────────
    #[test]
    fn test_fold_state_toggle() {
        let mut fs = FoldState::new();
        assert!(!fs.is_collapsed("t1"));
        fs.toggle("t1".into());
        assert!(fs.is_collapsed("t1"));
        fs.toggle("t1".into());
        assert!(!fs.is_collapsed("t1"));
    }

    #[test]
    fn test_fold_state_collapse_expand() {
        let mut fs = FoldState::new();
        fs.collapse("t1".into());
        assert!(fs.is_collapsed("t1"));
        fs.expand("t1".into());
        assert!(!fs.is_collapsed("t1"));
    }

    #[test]
    fn test_fold_state_expand_all() {
        let mut fs = FoldState::new();
        fs.collapse("t1".into());
        fs.collapse("t2".into());
        fs.expand_all();
        assert!(!fs.is_collapsed("t1"));
        assert!(!fs.is_collapsed("t2"));
    }

    #[test]
    fn test_fold_state_collapse_all() {
        let mut fs = FoldState::new();
        let ids = vec!["t1".into(), "t2".into(), "t3".into()];
        fs.collapse_all(&ids);
        assert!(fs.is_collapsed("t1"));
        assert!(fs.is_collapsed("t2"));
        assert!(fs.is_collapsed("t3"));
    }

    // ── Thread tests ───────────────────────────────────────────────
    #[test]
    fn test_thread_new() {
        let mut tags = HashSet::new();
        tags.insert("unread".into());
        let t = Thread::new(
            "thread1".into(),
            "Test".into(),
            "Alice".into(),
            "2h ago".into(),
            tags.clone(),
            5,
            3,
        );
        assert_eq!(t.thread_id, "thread1");
        assert_eq!(t.message_count, 5);
        assert_eq!(t.matched_messages, 3);
        assert!(t.is_unread());
        assert!(!t.is_flagged());
    }

    #[test]
    fn test_thread_flagged() {
        let mut tags = HashSet::new();
        tags.insert("flagged".into());
        let t = Thread::new(
            "t1".into(),
            "Subj".into(),
            "Bob".into(),
            "now".into(),
            tags,
            1,
            1,
        );
        assert!(t.is_flagged());
        assert!(!t.is_unread());
    }

    // ── VimMode Display ────────────────────────────────────────────
    #[test]
    fn test_vim_mode_display() {
        assert_eq!(format!("{}", VimMode::Normal), "NORMAL");
        assert_eq!(format!("{}", VimMode::Insert), "INSERT");
        assert_eq!(format!("{}", VimMode::Command), "COMMAND");
        assert_eq!(format!("{}", VimMode::Search), "SEARCH");
    }
}
