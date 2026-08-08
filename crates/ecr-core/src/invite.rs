//! Meeting invitations, read out of a `text/calendar` part.
//!
//! An invitation arrives as a MIME part nobody reads: ecr showed it as an
//! attachment called `invite.ics`, which is a file the reader has to download
//! and open somewhere else to find out when a meeting is. Every client on the
//! parity list renders it in place, and that is most of the value — knowing
//! what and when, without leaving the message.
//!
//! Replying (`METHOD:REPLY`) is a different thing and is not here. It writes to
//! somebody else's calendar and has to be right about time zones, recurrence
//! and delegation; showing the invitation is worth having on its own and cannot
//! be wrong about anything.

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
            "DTSTART" => invite.starts = Some(value),
            "DTEND" => invite.ends = Some(value),
            "RRULE" => invite.recurring = true,
            _ => {}
        }
    }

    invite.is_useful().then_some(invite)
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

    #[test]
    fn something_that_is_not_a_calendar_is_not_an_invitation() {
        assert!(parse("hello").is_none());
        assert!(parse("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n").is_none());
    }
}
