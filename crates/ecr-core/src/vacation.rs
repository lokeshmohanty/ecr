//! The vacation responder, and the many things it must not reply to.
//!
//! An autoresponder is the one feature in a mail client that sends mail nobody
//! read first. Everything else here is a decision somebody made; this is a
//! decision made on their behalf, at three in the morning, about a message they
//! have not seen. So the whole of this module is about **when not to send**.
//!
//! The failures are not hypothetical and they are not small:
//!
//! - Replying to a mailing list sends "I am on holiday" to every subscriber,
//!   from an address that then keeps doing it for a fortnight.
//! - Replying to another autoresponder is a loop that ends when one of the two
//!   mail servers starts refusing, having sent thousands of messages.
//! - Replying to a bounce sends mail to a null sender, which bounces, which is
//!   the same loop with an extra hop.
//! - Replying to every message from one correspondent means a colleague who
//!   sends six things in an afternoon gets six identical notices.
//!
//! Each of those is prevented here, and each check is worth more than the
//! feature it guards. The decision is pure — no clock, no filesystem, no
//! network — so all of it can be tested, which for something that sends mail
//! unattended is the point.

use serde::{Deserialize, Serialize};

/// How long, by default, before the same person is told again.
///
/// A week rather than a day: the notice is the same every time, and somebody
/// who writes daily does not need it daily. Long enough to be unobtrusive,
/// short enough that a correspondence resumed after a fortnight is still met
/// with an answer.
pub const DEFAULT_INTERVAL_DAYS: u32 = 7;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vacation {
    /// Off unless it is explicitly on. A responder that could be switched on by
    /// an upgrade, a default or a merge is one that mails everybody you know.
    #[serde(default)]
    pub enabled: bool,
    /// The subject of the reply. The original's, prefixed, when this is unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub body: String,
    /// Unix seconds. Outside the window nothing is sent, even when enabled.
    ///
    /// The window exists so the responder can be set up *before* leaving and
    /// stop by itself on returning. Somebody who has to remember to switch it
    /// off is somebody who will, eventually, forget for a month.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    /// How long before the same correspondent is answered again.
    #[serde(default = "default_interval")]
    pub interval_days: u32,
    /// An extra notmuch query the message must match, for anyone who wants to
    /// answer only some of their mail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

fn default_interval() -> u32 {
    DEFAULT_INTERVAL_DAYS
}

impl Default for Vacation {
    fn default() -> Self {
        Self {
            enabled: false,
            subject: None,
            body: String::new(),
            from: None,
            until: None,
            interval_days: DEFAULT_INTERVAL_DAYS,
            query: None,
        }
    }
}

/// Everything about one arrived message that bears on whether to answer it.
///
/// A plain struct rather than a parsed message, so the decision can be tested
/// exhaustively without building mail. Header names are lowercased and values
/// are as they arrived.
#[derive(Debug, Clone, Default)]
pub struct Arrived {
    /// The address in `From:`.
    pub from: String,
    /// Every address in `To:` and `Cc:`.
    pub to: Vec<String>,
    /// Header name (lowercased) to value, for the headers below.
    pub headers: Vec<(String, String)>,
    pub message_id: Option<String>,
    pub subject: String,
}

impl Arrived {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Why a message was not answered. Every variant is a real class of mail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Skip {
    /// The responder is off, or today is outside its window.
    NotOn,
    /// A mailing list. Answering one writes to every subscriber.
    List,
    /// Already machine-generated: another responder, a bounce, a receipt. RFC
    /// 3834 exists precisely so these can be told apart, and honouring it is
    /// what stops two responders talking to each other forever.
    Automatic,
    /// From one of our own addresses. Answering yourself is a loop with one
    /// participant.
    Ourselves,
    /// We were not actually addressed — Bcc, or a list expansion. Someone who
    /// was not written to should not answer.
    NotAddressed,
    /// This person has already been told, recently enough.
    AlreadyTold { seconds_ago: i64 },
    /// A null or malformed sender. There is nowhere to reply to.
    NoSender,
}

/// What to do about one arrived message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Reply { to: String, subject: String },
    Skip(Skip),
}

/// Headers whose mere presence means the message was machine-generated.
///
/// `List-Id` and friends are the mailing-list markers; `Auto-Submitted` is RFC
/// 3834's; the `X-Auto*` set is what Exchange and several older responders
/// send instead. Checking all of them rather than the standard one alone
/// matters because the non-standard senders are exactly the ones that will
/// answer back.
const MACHINE_HEADERS: &[&str] = &[
    "list-id",
    "list-post",
    "list-unsubscribe",
    "list-help",
    "mailing-list",
    "x-mailing-list",
    "x-auto-response-suppress",
    "x-autoreply",
    "x-autorespond",
    "x-autogenerated",
];

/// Whether, and how, to answer one message.
///
/// `ours` is every address this installation sends as — aliases included, or a
/// message to an alias is answered as though it came from a stranger.
/// `last_reply` is when this correspondent was last told, if ever.
pub fn decide(
    vacation: &Vacation,
    arrived: &Arrived,
    ours: &[String],
    now: i64,
    last_reply: Option<i64>,
) -> Decision {
    if !vacation.enabled {
        return Decision::Skip(Skip::NotOn);
    }
    if vacation.from.is_some_and(|start| now < start) || vacation.until.is_some_and(|end| now > end)
    {
        return Decision::Skip(Skip::NotOn);
    }

    // The bare address, not the header. A `From:` line carries a display name
    // far more often than not, and every test below that looks at the *start*
    // of the string — the daemon check especially — silently stops matching
    // the moment one is present, which is to say on real mail and not on any
    // fixture written by hand.
    let sender = bare(&arrived.from);
    // A null sender is how a bounce and every other delivery notification
    // identifies itself. Answering one sends mail to nowhere, which bounces,
    // which arrives here again.
    if sender.is_empty()
        || !sender.contains('@')
        || sender.starts_with("mailer-daemon@")
        || sender.starts_with("postmaster@")
    {
        return Decision::Skip(Skip::NoSender);
    }

    if ours.iter().any(|address| same_address(address, &sender)) {
        return Decision::Skip(Skip::Ourselves);
    }

    // RFC 3834. `auto-generated` and `auto-replied` are both machine mail;
    // `no` is the explicit opposite and is the only value that means a person
    // sent this.
    if let Some(value) = arrived.header("auto-submitted") {
        if !value.trim().eq_ignore_ascii_case("no") {
            return Decision::Skip(Skip::Automatic);
        }
    }
    // Precedence is not a standard, but it is what almost everything actually
    // sets, and it predates the standard by two decades.
    if let Some(value) = arrived.header("precedence") {
        let value = value.trim().to_ascii_lowercase();
        if matches!(value.as_str(), "bulk" | "list" | "junk" | "auto_reply") {
            return Decision::Skip(Skip::Automatic);
        }
    }
    if MACHINE_HEADERS
        .iter()
        .any(|name| arrived.header(name).is_some())
    {
        return Decision::Skip(Skip::List);
    }

    // Somebody who was not written to should not answer. This is what keeps a
    // responder off list mail that carries none of the markers above, and off
    // anything the reader was merely Bcc'd on.
    if !arrived
        .to
        .iter()
        .any(|recipient| ours.iter().any(|address| same_address(address, recipient)))
    {
        return Decision::Skip(Skip::NotAddressed);
    }

    if let Some(last) = last_reply {
        let interval = i64::from(vacation.interval_days) * 86_400;
        let ago = now - last;
        // `<` rather than `<=`, and a clock that has gone backwards counts as
        // recent: a machine whose time jumps must not become a machine that
        // answers every message.
        if ago < interval {
            return Decision::Skip(Skip::AlreadyTold { seconds_ago: ago });
        }
    }

    Decision::Reply {
        to: arrived.from.trim().to_string(),
        subject: subject_for(vacation, &arrived.subject),
    }
}

fn subject_for(vacation: &Vacation, original: &str) -> String {
    if let Some(subject) = &vacation.subject {
        return subject.clone();
    }
    // Not doubled up: a thread that has been round a few times already carries
    // one, and `Re: Re: Re:` is what a responder that does not check looks
    // like from the other end.
    if original.trim().to_ascii_lowercase().starts_with("re:") {
        original.trim().to_string()
    } else {
        format!("Re: {}", original.trim())
    }
}

/// Whether two addresses are the same one.
///
/// Compares the address inside angle brackets when there is one, so
/// `Ada <ada@example.com>` and `ada@example.com` are recognised as the same
/// person — otherwise the responder answers its own notice, because the From
/// line it generated carries a display name and the one it compares against
/// does not.
fn same_address(a: &str, b: &str) -> bool {
    bare(a).eq_ignore_ascii_case(&bare(b))
}

fn bare(address: &str) -> String {
    let text = address.trim();
    let inner = match (text.rfind('<'), text.rfind('>')) {
        (Some(open), Some(close)) if close > open => &text[open + 1..close],
        _ => text,
    };
    inner.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    const US: &str = "ada@example.com";

    fn ours() -> Vec<String> {
        vec![US.to_string(), "ada+lists@example.com".to_string()]
    }

    fn on() -> Vacation {
        Vacation {
            enabled: true,
            body: "I am away until Monday.".into(),
            ..Vacation::default()
        }
    }

    fn from_a_person() -> Arrived {
        Arrived {
            from: "Grace <grace@example.org>".into(),
            to: vec![US.into()],
            subject: "lunch?".into(),
            ..Arrived::default()
        }
    }

    fn with_header(name: &str, value: &str) -> Arrived {
        let mut arrived = from_a_person();
        arrived.headers.push((name.into(), value.into()));
        arrived
    }

    fn decide_now(vacation: &Vacation, arrived: &Arrived) -> Decision {
        decide(vacation, arrived, &ours(), 1_000_000, None)
    }

    #[test]
    fn an_ordinary_message_from_a_person_is_answered() {
        match decide_now(&on(), &from_a_person()) {
            Decision::Reply { to, subject } => {
                assert!(to.contains("grace@example.org"));
                assert_eq!(subject, "Re: lunch?");
            }
            other => panic!("a person got no answer: {other:?}"),
        }
    }

    /// Off unless explicitly on. A responder that a default or a merge could
    /// switch on is one that mails everybody you know.
    #[test]
    fn nothing_is_sent_while_it_is_off() {
        let off = Vacation {
            enabled: false,
            ..on()
        };
        assert_eq!(
            decide_now(&off, &from_a_person()),
            Decision::Skip(Skip::NotOn)
        );
    }

    /// The window is what lets it be set up before leaving and stop by itself
    /// on returning. Somebody who has to remember to switch it off will,
    /// eventually, forget for a month.
    #[test]
    fn the_window_starts_and_ends_by_itself() {
        let vacation = Vacation {
            from: Some(1_000),
            until: Some(2_000),
            ..on()
        };
        let arrived = from_a_person();

        assert_eq!(
            decide(&vacation, &arrived, &ours(), 999, None),
            Decision::Skip(Skip::NotOn),
            "answered before it began"
        );
        assert!(matches!(
            decide(&vacation, &arrived, &ours(), 1_500, None),
            Decision::Reply { .. }
        ));
        assert_eq!(
            decide(&vacation, &arrived, &ours(), 2_001, None),
            Decision::Skip(Skip::NotOn),
            "still answering after it ended"
        );
    }

    /// Answering a list writes "I am on holiday" to every subscriber, from an
    /// address that then keeps doing it for a fortnight.
    #[test]
    fn a_mailing_list_is_never_answered() {
        for header in [
            "List-Id",
            "List-Post",
            "List-Unsubscribe",
            "Mailing-List",
            "X-Mailing-List",
        ] {
            assert_eq!(
                decide_now(&on(), &with_header(header, "<x.example.org>")),
                Decision::Skip(Skip::List),
                "{header} did not stop it"
            );
        }
    }

    /// The loop this whole module exists to prevent: two responders talking to
    /// each other until a mail server starts refusing.
    #[test]
    fn another_autoresponder_is_never_answered() {
        for (header, value) in [
            ("Auto-Submitted", "auto-replied"),
            ("Auto-Submitted", "auto-generated"),
            ("Precedence", "bulk"),
            ("Precedence", "junk"),
            ("Precedence", "list"),
            ("X-Autoreply", "yes"),
            ("X-Auto-Response-Suppress", "All"),
        ] {
            let decision = decide_now(&on(), &with_header(header, value));
            assert!(
                matches!(decision, Decision::Skip(Skip::Automatic | Skip::List)),
                "{header}: {value} did not stop it — got {decision:?}"
            );
        }
    }

    /// `Auto-Submitted: no` is the explicit statement that a person sent this,
    /// and is the one value that must not suppress a reply.
    #[test]
    fn auto_submitted_no_still_gets_an_answer() {
        assert!(matches!(
            decide_now(&on(), &with_header("Auto-Submitted", "no")),
            Decision::Reply { .. }
        ));
    }

    /// A bounce has nowhere to reply to. Answering one sends mail to nowhere,
    /// which bounces, which arrives here again.
    ///
    /// The display-name forms are the ones that matter: a `From:` line carries
    /// one far more often than not, and a check written against the start of
    /// the raw header stops matching the moment one is present — which is to
    /// say on real mail, and on no fixture written by hand.
    #[test]
    fn a_bounce_or_a_null_sender_is_never_answered() {
        for sender in [
            "",
            "MAILER-DAEMON@example.org",
            "Mail Delivery System <MAILER-DAEMON@example.org>",
            "Postmaster <postmaster@example.org>",
            "not-an-address",
        ] {
            let mut arrived = from_a_person();
            arrived.from = sender.into();
            assert_eq!(
                decide_now(&on(), &arrived),
                Decision::Skip(Skip::NoSender),
                "{sender:?} was answered"
            );
        }
    }

    /// A loop with one participant. The display name on the generated From
    /// line is why this compares bare addresses.
    #[test]
    fn we_never_answer_ourselves() {
        let mut arrived = from_a_person();
        arrived.from = format!("Ada Lovelace <{US}>");

        assert_eq!(decide_now(&on(), &arrived), Decision::Skip(Skip::Ourselves));
    }

    /// Somebody who was not written to should not answer. This is what keeps
    /// the responder off list mail carrying none of the usual markers, and off
    /// anything the reader was merely Bcc'd on.
    #[test]
    fn mail_we_were_not_addressed_on_is_left_alone() {
        let mut arrived = from_a_person();
        arrived.to = vec!["someone-else@example.org".into()];

        assert_eq!(
            decide_now(&on(), &arrived),
            Decision::Skip(Skip::NotAddressed)
        );
    }

    /// An alias is still us. Without this, mail to an alias is answered as
    /// though it had been sent to a stranger.
    #[test]
    fn an_alias_counts_as_being_addressed() {
        let mut arrived = from_a_person();
        arrived.to = vec!["Ada <ada+lists@example.com>".into()];

        assert!(matches!(
            decide_now(&on(), &arrived),
            Decision::Reply { .. }
        ));
    }

    /// A colleague who sends six things in an afternoon must not get six
    /// identical notices.
    #[test]
    fn the_same_person_is_not_told_twice_in_a_week() {
        let now = 10_000_000;
        let arrived = from_a_person();

        let yesterday = now - 86_400;
        assert!(matches!(
            decide(&on(), &arrived, &ours(), now, Some(yesterday)),
            Decision::Skip(Skip::AlreadyTold { .. })
        ));

        let a_fortnight_ago = now - 14 * 86_400;
        assert!(
            matches!(
                decide(&on(), &arrived, &ours(), now, Some(a_fortnight_ago)),
                Decision::Reply { .. }
            ),
            "a correspondence resumed after a fortnight got no answer"
        );
    }

    /// A machine whose clock jumps backwards must not become a machine that
    /// answers every message.
    #[test]
    fn a_clock_that_went_backwards_does_not_restart_the_replies() {
        let now = 10_000_000;
        let from_the_future = now + 86_400;

        assert!(matches!(
            decide(&on(), &from_a_person(), &ours(), now, Some(from_the_future)),
            Decision::Skip(Skip::AlreadyTold { .. })
        ));
    }

    /// `Re: Re: Re:` is what a responder that does not check looks like from
    /// the other end.
    #[test]
    fn the_subject_is_not_prefixed_twice() {
        let mut arrived = from_a_person();
        arrived.subject = "Re: lunch?".into();

        match decide_now(&on(), &arrived) {
            Decision::Reply { subject, .. } => assert_eq!(subject, "Re: lunch?"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_chosen_subject_is_used_as_written() {
        let vacation = Vacation {
            subject: Some("Away until Monday".into()),
            ..on()
        };

        match decide_now(&vacation, &from_a_person()) {
            Decision::Reply { subject, .. } => assert_eq!(subject, "Away until Monday"),
            other => panic!("{other:?}"),
        }
    }
}
