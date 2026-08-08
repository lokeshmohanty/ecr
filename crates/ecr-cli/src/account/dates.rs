//! Dates for the command line, without a date library.
//!
//! Two conversions — a calendar date to a Unix second and back — are all the
//! CLI needs, and Howard Hinnant's civil-date algorithms do them exactly with
//! no dependencies. A date crate for this would be a fetch, a version to
//! track and a Nix hash to keep in step, for arithmetic that has been settled
//! since 1582.

pub fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `YYYY-MM-DD`, as midnight UTC.
///
/// Deliberately not a full date parser: a responder's dates are read from a
/// calendar, and every other format anyone might type is ambiguous about which
/// number is the month — which for this feature means being away for the wrong
/// fortnight.
pub fn parse(text: &str) -> anyhow::Result<i64> {
    let parts: Vec<&str> = text.trim().split('-').collect();
    let bad = || anyhow::anyhow!("{text} is not a date; write it as YYYY-MM-DD");

    if parts.len() != 3 {
        return Err(bad());
    }
    let year: i64 = parts[0].parse().map_err(|_| bad())?;
    let month: i64 = parts[1].parse().map_err(|_| bad())?;
    let day: i64 = parts[2].parse().map_err(|_| bad())?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(bad());
    }

    Ok(days_from_civil(year, month, day) * 86_400)
}

pub fn format(seconds: i64) -> String {
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

/// Howard Hinnant's civil-date algorithms, which are exact and have no
/// dependencies. A date library for two conversions would be a fetch, a
/// version to track and a Nix hash to keep in step.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };

    (year + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every other format anyone might type is ambiguous about which number is
    /// the month, and for a vacation responder that means being away for the
    /// wrong fortnight.
    #[test]
    fn dates_round_trip_through_the_epoch() {
        for date in ["2026-01-01", "2026-08-08", "1970-01-01", "2000-02-29"] {
            assert_eq!(format(parse(date).unwrap()), date, "{date} did not survive");
        }
    }

    #[test]
    fn the_epoch_is_where_it_should_be() {
        assert_eq!(parse("1970-01-01").unwrap(), 0);
        assert_eq!(parse("2026-08-08").unwrap(), 1_786_147_200);
    }

    /// A leap day is the one date a naive month-length table gets wrong, and
    /// the century rule is the one a naive leap-year test gets wrong.
    #[test]
    fn leap_years_and_the_century_rule_are_both_right() {
        assert_eq!(format(parse("2000-02-29").unwrap()), "2000-02-29");
        assert_eq!(format(parse("2024-02-29").unwrap()), "2024-02-29");
        // 1900 was not a leap year, so its 60th day is the 1st of March.
        assert_eq!(format(parse("1900-03-01").unwrap()), "1900-03-01");
    }

    /// Before the epoch the arithmetic has to floor rather than truncate, and
    /// a `/` where `div_euclid` belongs is off by a day for every date here.
    #[test]
    fn dates_before_the_epoch_are_not_off_by_a_day() {
        for date in ["1969-12-31", "1900-01-01", "1600-02-29"] {
            assert_eq!(format(parse(date).unwrap()), date, "{date} did not survive");
        }
        assert!(parse("1969-12-31").unwrap() < 0);
    }

    #[test]
    fn anything_that_is_not_a_date_is_refused_rather_than_guessed() {
        for text in [
            "08/08/2026",
            "tomorrow",
            "2026-13-01",
            "2026-08",
            "",
            "2026-00-10",
            "2026-01-32",
        ] {
            assert!(parse(text).is_err(), "{text:?} was accepted");
        }
    }
}
