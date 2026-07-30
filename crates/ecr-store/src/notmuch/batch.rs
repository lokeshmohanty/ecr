use crate::error::{Error, Result};
use ecr_core::message::TagOp;

pub fn build(ops: &[TagOp]) -> Result<String> {
    let mut batch = String::new();

    for op in ops {
        if op.is_empty() {
            continue;
        }
        for tag in op.add.iter().chain(op.remove.iter()) {
            validate_tag(tag)?;
        }

        for tag in &op.add {
            batch.push('+');
            batch.push_str(&encode_tag(tag));
            batch.push(' ');
        }
        for tag in &op.remove {
            batch.push('-');
            batch.push_str(&encode_tag(tag));
            batch.push(' ');
        }

        batch.push_str("-- ");
        batch.push_str(&op.id.query());
        batch.push('\n');
    }

    Ok(batch)
}

fn validate_tag(tag: &str) -> Result<()> {
    if tag.trim().is_empty() {
        return Err(Error::InvalidTag {
            tag: tag.to_string(),
            reason: "a tag cannot be empty",
        });
    }
    if tag.chars().any(char::is_control) {
        return Err(Error::InvalidTag {
            tag: tag.to_string(),
            reason: "a tag cannot contain control characters",
        });
    }
    if tag.starts_with('-') || tag.starts_with('+') {
        return Err(Error::InvalidTag {
            tag: tag.to_string(),
            reason: "a tag cannot start with '+' or '-'",
        });
    }
    Ok(())
}

fn encode_tag(tag: &str) -> String {
    let mut out = String::with_capacity(tag.len());
    for ch in tag.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '/' | '@' | ':') {
            out.push(ch);
        } else {
            let mut buf = [0u8; 4];
            for byte in ch.encode_utf8(&mut buf).as_bytes() {
                out.push_str(&format!("%{byte:02x}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ecr_core::message::MessageId;

    fn op(id: &str) -> TagOp {
        TagOp::new(MessageId::from(id))
    }

    #[test]
    fn builds_one_line_per_message() {
        let batch = build(&[
            op("a@x").adding("starred").removing("unread"),
            op("b@x").removing("inbox"),
        ])
        .unwrap();

        assert_eq!(
            batch,
            "+starred -unread -- id:\"a@x\"\n-inbox -- id:\"b@x\"\n"
        );
    }

    #[test]
    fn skips_operations_with_nothing_to_do() {
        let batch = build(&[op("a@x"), op("b@x").adding("seen")]).unwrap();
        assert_eq!(batch, "+seen -- id:\"b@x\"\n");
    }

    #[test]
    fn no_operations_produces_an_empty_batch() {
        assert_eq!(build(&[]).unwrap(), "");
    }

    #[test]
    fn a_tag_with_a_space_is_percent_encoded_not_silently_split() {
        let batch = build(&[op("a@x").adding("needs review")]).unwrap();
        assert_eq!(batch, "+needs%20review -- id:\"a@x\"\n");
    }

    #[test]
    fn a_newline_in_a_tag_is_rejected_rather_than_forging_a_batch_line() {
        let err = build(&[op("a@x").adding("evil\n-inbox -- *")]).unwrap_err();
        assert!(matches!(err, Error::InvalidTag { .. }), "{err:?}");
    }

    #[test]
    fn an_empty_tag_is_rejected() {
        assert!(build(&[op("a@x").adding("   ")]).is_err());
    }

    #[test]
    fn a_tag_starting_with_a_sign_is_rejected() {
        assert!(build(&[op("a@x").adding("-inbox")]).is_err());
        assert!(build(&[op("a@x").removing("+inbox")]).is_err());
    }

    #[test]
    fn ordinary_tag_punctuation_survives_untouched() {
        let batch = build(&[op("a@x").adding("lists/rust-dev")]).unwrap();
        assert_eq!(batch, "+lists/rust-dev -- id:\"a@x\"\n");
    }

    #[test]
    fn unicode_tags_are_encoded_bytewise() {
        let batch = build(&[op("a@x").adding("café")]).unwrap();
        assert_eq!(batch, "+caf%c3%a9 -- id:\"a@x\"\n");
    }
}
