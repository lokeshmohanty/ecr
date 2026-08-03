//! notmuch's `date_relative`, close enough.
//!
//! The client formats its own dates from `timestamp` — that string is a
//! sentence, never the same width, and never says what time a message arrived
//! — so this exists to keep the field meaning something for anything else
//! reading the API. It follows the shape of notmuch's own rendering rather than
//! its source, and is the one field of a summary that is not asserted to match.

use chrono::{DateTime, Datelike, Local, TimeZone};

pub fn now() -> i64 {
    Local::now().timestamp()
}

pub fn describe(timestamp: i64, now: i64) -> String {
    let Some(then) = Local.timestamp_opt(timestamp, 0).single() else {
        return String::new();
    };
    let Some(now_at) = Local.timestamp_opt(now, 0).single() else {
        return String::new();
    };

    let delta = now - timestamp;
    if delta < 0 {
        return "the future".into();
    }
    if delta < 60 {
        return "now".into();
    }
    if delta < 3600 {
        let mins = delta / 60;
        return format!("{mins} min{}. ago", if mins == 1 { "" } else { "s" });
    }

    let days = now_at.date_naive().signed_duration_since(then.date_naive());
    match days.num_days() {
        0 => format!("Today {}", clock(&then)),
        1 => format!("Yest. {}", clock(&then)),
        2..=6 => format!("{}. {}", then.format("%a"), clock(&then)),
        _ if then.year() == now_at.year() => then.format("%B %d").to_string(),
        _ => then.format("%Y-%m-%d").to_string(),
    }
}

fn clock(at: &DateTime<Local>) -> String {
    at.format("%H:%M").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400;

    fn at(text: &str) -> i64 {
        DateTime::parse_from_rfc3339(text)
            .expect("timestamp")
            .timestamp()
    }

    #[test]
    fn the_last_minute_is_now() {
        let now = at("2026-04-01T12:00:00+05:30");
        assert_eq!(describe(now - 30, now), "now");
    }

    #[test]
    fn minutes_are_counted_singly() {
        let now = at("2026-04-01T12:00:00+05:30");
        assert_eq!(describe(now - 60, now), "1 min. ago");
        assert_eq!(describe(now - 600, now), "10 mins. ago");
    }

    #[test]
    fn a_date_this_year_is_the_month_and_day() {
        let now = at("2026-08-03T12:00:00+05:30");
        let then = at("2026-04-01T09:30:00+05:30");
        assert_eq!(describe(then, now), "April 01");
    }

    #[test]
    fn an_older_date_is_iso() {
        let now = at("2026-08-03T12:00:00+05:30");
        let then = at("2024-04-01T09:30:00+05:30");
        assert_eq!(describe(then, now), "2024-04-01");
    }

    #[test]
    fn yesterday_is_named() {
        let now = at("2026-08-03T12:00:00+05:30");
        assert!(describe(now - DAY, now).starts_with("Yest. "));
    }

    #[test]
    fn a_message_from_the_future_says_so() {
        let now = at("2026-08-03T12:00:00+05:30");
        assert_eq!(describe(now + DAY, now), "the future");
    }
}
