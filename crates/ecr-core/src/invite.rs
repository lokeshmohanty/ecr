//! Meeting invitations, read out of a `text/calendar` part.
//!
//! An invitation arrives as a MIME part nobody reads: ecr showed it as an
//! attachment called `invite.ics`, which is a file the reader has to download
//! and open somewhere else to find out when a meeting is. Every client on the
//! parity list renders it in place, and that is most of the value — knowing
//! what and when, without leaving the message.
//!
//! Replying is [`reply`], which builds the `METHOD:REPLY` calendar an organiser's
//! software reads to move somebody from *invited* to *going*. It is deliberately
//! a narrow thing: it echoes the event's identity back unchanged and changes one
//! `PARTSTAT`. It does not touch recurrence — answering a single occurrence of a
//! repeating meeting needs a `RECURRENCE-ID` that says which one, and sending a
//! reply without it answers the *series*, so a reply to one occurrence is
//! refused rather than sent as something it is not.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invite {
    pub summary: Option<String>,
    pub location: Option<String>,
    pub description: Option<String>,
    pub organizer: Option<String>,
    pub attendees: Vec<String>,
    /// As written in the calendar, in the form it was written — this is not
    /// parsed into an instant, because doing that wrongly is worse than showing
    /// the reader what the sender actually said.
    pub starts: Option<String>,
    pub ends: Option<String>,
    /// `REQUEST`, `REPLY`, `CANCEL` — what this message is *doing* about the
    /// event, which is the difference between an invitation and a cancellation.
    pub method: Option<String>,
    pub recurring: bool,
    /// The event's identity, which a reply has to echo back unchanged or the
    /// organiser's software cannot match it to anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<String>,
    /// Set when this is one occurrence of a repeating event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_id: Option<String>,
}

/// What somebody is saying about an invitation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Answer {
    Accept,
    Decline,
    Tentative,
}

impl Answer {
    /// The `PARTSTAT` an organiser's software reads.
    pub fn partstat(&self) -> &'static str {
        match self {
            Answer::Accept => "ACCEPTED",
            Answer::Decline => "DECLINED",
            Answer::Tentative => "TENTATIVE",
        }
    }

    /// What the subject line of the reply says, which is the part a human reads
    /// when their client does not understand the calendar part.
    pub fn prefix(&self) -> &'static str {
        match self {
            Answer::Accept => "Accepted",
            Answer::Decline => "Declined",
            Answer::Tentative => "Tentative",
        }
    }
}

impl Invite {
    pub fn is_cancellation(&self) -> bool {
        self.method
            .as_deref()
            .is_some_and(|m| m.eq_ignore_ascii_case("CANCEL"))
    }

    /// Whether there is enough here to be worth showing.
    pub fn is_useful(&self) -> bool {
        self.summary.is_some() || self.starts.is_some()
    }
}

/// Parses the first `VEVENT` in an iCalendar document.
pub fn parse(ics: &str) -> Option<Invite> {
    let unfolded = unfold(ics);
    let mut invite = Invite::default();
    let mut in_event = false;

    for line in unfolded.lines() {
        let upper = line.trim().to_ascii_uppercase();
        if upper == "BEGIN:VEVENT" {
            in_event = true;
            continue;
        }
        if upper == "END:VEVENT" {
            break;
        }

        let Some((property, value)) = line.split_once(':') else {
            continue;
        };
        let key = property
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_uppercase();
        let value = unescape(value.trim());
        if value.is_empty() {
            continue;
        }

        // METHOD sits outside the VEVENT, in the calendar itself.
        if key == "METHOD" && !in_event {
            invite.method = Some(value.to_ascii_uppercase());
            continue;
        }
        if !in_event {
            continue;
        }

        match key.as_str() {
            "SUMMARY" => invite.summary = Some(value),
            "LOCATION" => invite.location = Some(value),
            "DESCRIPTION" => invite.description = Some(value),
            // `ORGANIZER;CN=Alice:mailto:alice@example.com` — the address is
            // what identifies them; the display name is in a parameter and is
            // not worth a parameter parser here.
            "ORGANIZER" => invite.organizer = Some(strip_mailto(&value)),
            "ATTENDEE" => invite.attendees.push(strip_mailto(&value)),
            "UID" => invite.uid = Some(value),
            "SEQUENCE" => invite.sequence = Some(value),
            "RECURRENCE-ID" => invite.recurrence_id = Some(value),
            "DTSTART" => invite.starts = Some(value),
            "DTEND" => invite.ends = Some(value),
            "RRULE" => invite.recurring = true,
            _ => {}
        }
    }

    invite.is_useful().then_some(invite)
}

/// Builds the `METHOD:REPLY` calendar that answers an invitation.
///
/// `attendee` is the address answering — it has to be one the invitation was
/// actually sent to, or the organiser's software has nobody to move.
///
/// Refused for one occurrence of a repeating event: answering that needs a
/// `RECURRENCE-ID` on the reply saying *which* occurrence, and a reply without
/// one answers the whole series. Silently changing every future Monday because
/// somebody declined one of them is the kind of wrong that is only discovered
/// weeks later.
pub fn reply(invite: &Invite, attendee: &str, answer: Answer) -> Result<String, &'static str> {
    let uid = invite.uid.as_deref().ok_or(
        "this invitation carries no UID, so there is nothing for the organiser to match a \
         reply to",
    )?;
    if invite.recurring && invite.recurrence_id.is_none() {
        return Err(
            "this is a repeating event, and answering one occurrence of it is not something \
             ecr does yet — a reply without a RECURRENCE-ID answers the whole series",
        );
    }
    let organizer = invite
        .organizer
        .as_deref()
        .ok_or("this invitation names no organiser to reply to")?;

    // CRLF throughout, because RFC 5545 says so and a calendar with bare LFs is
    // one some servers accept and others reject outright — a failure that looks
    // like the invitation rather than the reply.
    let mut out = String::new();
    let mut line = |text: String| {
        out.push_str(&text);
        out.push_str("\r\n");
    };

    line("BEGIN:VCALENDAR".into());
    line("VERSION:2.0".into());
    line("PRODID:-//ecr//EN".into());
    line("METHOD:REPLY".into());
    line("BEGIN:VEVENT".into());
    line(format!("UID:{}", escape(uid)));

    // Echoed back unchanged. SEQUENCE is how an organiser tells a reply to the
    // invitation they sent from a reply to one they have since revised, and
    // answering with the wrong one answers a meeting that has moved.
    if let Some(sequence) = &invite.sequence {
        line(format!("SEQUENCE:{}", escape(sequence)));
    }
    if let Some(recurrence) = &invite.recurrence_id {
        line(format!("RECURRENCE-ID:{}", escape(recurrence)));
    }
    if let Some(starts) = &invite.starts {
        line(format!("DTSTART:{}", escape(starts)));
    }
    if let Some(summary) = &invite.summary {
        line(format!("SUMMARY:{}", escape(summary)));
    }

    line(format!("ORGANIZER:mailto:{}", escape(organizer)));
    line(format!(
        "ATTENDEE;PARTSTAT={}:mailto:{}",
        answer.partstat(),
        escape(attendee)
    ));
    line("END:VEVENT".into());
    line("END:VCALENDAR".into());
    Ok(out)
}

/// iCalendar's own escaping, which is not the same as anybody else's: a comma
/// or a semicolon left raw ends the value early, and a newline inside one turns
/// the rest of it into a property nobody meant to send.
fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', " ")
        .replace('\r', "")
}

fn strip_mailto(value: &str) -> String {
    value
        .strip_prefix("mailto:")
        .or_else(|| value.strip_prefix("MAILTO:"))
        .unwrap_or(value)
        .to_string()
}

/// iCalendar folds long lines the same way vCard does, and an unfolded
/// `DESCRIPTION` is the difference between a readable agenda and one sentence.
fn unfold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        match line.strip_prefix([' ', '\t']) {
            Some(rest) if !out.is_empty() => out.push_str(rest),
            _ => {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(line);
            }
        }
    }
    out
}

fn unescape(value: &str) -> String {
    value
        .replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST: &str = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
METHOD:REQUEST\r\n\
BEGIN:VEVENT\r\n\
SUMMARY:Weekly sync\r\n\
DTSTART;TZID=Europe/London:20260410T090000\r\n\
DTEND;TZID=Europe/London:20260410T093000\r\n\
LOCATION:Room 3\\, second floor\r\n\
ORGANIZER;CN=Alice:mailto:alice@example.com\r\n\
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com\r\n\
RRULE:FREQ=WEEKLY\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

    #[test]
    fn an_invitation_gives_up_what_and_when() {
        let invite = parse(REQUEST).unwrap();

        assert_eq!(invite.summary.as_deref(), Some("Weekly sync"));
        assert_eq!(invite.starts.as_deref(), Some("20260410T090000"));
        assert_eq!(invite.location.as_deref(), Some("Room 3, second floor"));
        assert_eq!(invite.organizer.as_deref(), Some("alice@example.com"));
        assert_eq!(invite.attendees, vec!["bob@example.com"]);
        assert!(invite.recurring);
        assert_eq!(invite.method.as_deref(), Some("REQUEST"));
        assert!(!invite.is_cancellation());
    }

    /// A cancellation and an invitation are the same shape and opposite events.
    /// Showing one as the other puts a meeting in somebody's day that is not
    /// happening.
    #[test]
    fn a_cancellation_says_so() {
        let ics = REQUEST.replace("METHOD:REQUEST", "METHOD:CANCEL");
        assert!(parse(&ics).unwrap().is_cancellation());
    }

    #[test]
    fn a_folded_description_is_rejoined() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\n\
DESCRIPTION:the agenda is long and cont\r\n inues on the next line\r\n\
END:VEVENT\r\nEND:VCALENDAR\r\n";
        assert_eq!(
            parse(ics).unwrap().description.as_deref(),
            Some("the agenda is long and continues on the next line")
        );
    }

    /// METHOD is a property of the calendar, not of the event, so a parser that
    /// only looked inside VEVENT would never see it.
    #[test]
    fn the_method_is_read_from_outside_the_event() {
        let ics = "BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert_eq!(parse(ics).unwrap().method.as_deref(), Some("REPLY"));
    }

    const SINGLE: &str = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\n\
UID:abc-123\r\nSEQUENCE:2\r\nSUMMARY:One-off\r\nDTSTART:20260410T090000\r\n\
ORGANIZER;CN=Alice:mailto:alice@example.com\r\n\
ATTENDEE:mailto:bob@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn a_reply_echoes_the_events_identity_and_changes_one_partstat() {
        let invite = parse(SINGLE).unwrap();
        let ics = reply(&invite, "bob@example.com", Answer::Accept).unwrap();

        // RFC 5545 says CRLF, and a calendar with bare LFs is one some servers
        // take and others refuse — a failure that reads as the invitation being
        // broken rather than the reply.
        assert!(ics.contains("\r\n"), "not CRLF: {ics:?}");
        assert!(!ics.contains("\n\n"), "a bare LF got in: {ics:?}");
        assert!(ics.contains("METHOD:REPLY"), "{ics}");
        assert!(ics.contains("UID:abc-123"), "{ics}");
        // SEQUENCE is how an organiser tells a reply to the invitation they sent
        // from one to an invitation they have since revised.
        assert!(ics.contains("SEQUENCE:2"), "{ics}");
        assert!(
            ics.contains("ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com"),
            "{ics}"
        );
        assert!(ics.contains("ORGANIZER:mailto:alice@example.com"), "{ics}");
    }

    #[test]
    fn declining_and_tentative_are_the_same_reply_with_another_partstat() {
        let invite = parse(SINGLE).unwrap();
        assert!(reply(&invite, "bob@example.com", Answer::Decline)
            .unwrap()
            .contains("PARTSTAT=DECLINED"));
        assert!(reply(&invite, "bob@example.com", Answer::Tentative)
            .unwrap()
            .contains("PARTSTAT=TENTATIVE"));
    }

    /// A reply with no RECURRENCE-ID answers the *series*. Declining one Monday
    /// and silently clearing every future Monday is a wrong that is discovered
    /// weeks later, so it is refused rather than sent as something else.
    #[test]
    fn one_occurrence_of_a_repeating_event_is_refused_rather_than_answered_for_the_series() {
        let ics = SINGLE.replace("SEQUENCE:2", "SEQUENCE:2\r\nRRULE:FREQ=WEEKLY");
        let invite = parse(&ics).unwrap();

        let err = reply(&invite, "bob@example.com", Answer::Decline).unwrap_err();
        assert!(err.contains("RECURRENCE-ID"), "{err}");
    }

    #[test]
    fn a_named_occurrence_of_a_repeating_event_can_be_answered() {
        let ics = SINGLE.replace(
            "SEQUENCE:2",
            "SEQUENCE:2\r\nRRULE:FREQ=WEEKLY\r\nRECURRENCE-ID:20260417T090000",
        );
        let invite = parse(&ics).unwrap();

        let reply = reply(&invite, "bob@example.com", Answer::Accept).unwrap();
        assert!(reply.contains("RECURRENCE-ID:20260417T090000"), "{reply}");
    }

    #[test]
    fn an_invitation_with_no_uid_cannot_be_replied_to() {
        let ics = SINGLE.replace("UID:abc-123\r\n", "");
        let invite = parse(&ics).unwrap();
        assert!(reply(&invite, "bob@example.com", Answer::Accept).is_err());
    }

    /// A comma or semicolon left raw ends an iCalendar value early, and the rest
    /// of the summary becomes a property nobody meant to send.
    #[test]
    fn a_summary_with_punctuation_in_it_is_escaped() {
        let ics = SINGLE.replace("SUMMARY:One-off", "SUMMARY:Review; then lunch, maybe");
        let invite = parse(&ics).unwrap();

        let reply = reply(&invite, "bob@example.com", Answer::Accept).unwrap();
        assert!(
            reply.contains("SUMMARY:Review\\; then lunch\\, maybe"),
            "{reply}"
        );
    }

    #[test]
    fn something_that_is_not_a_calendar_is_not_an_invitation() {
        assert!(parse("hello").is_none());
        assert!(parse("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n").is_none());
    }
}
