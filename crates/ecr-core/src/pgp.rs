//! What a mail client can say about OpenPGP protection.
//!
//! The verdict is a wire type and lives here; the gpg that produces it lives in
//! `ecr-store`. A client renders a padlock from this and nothing else.

/// What gpg concluded about a signature.
///
/// A signature that is merely *present* is not a state — every one of these
/// says something different to a reader, and collapsing them into a boolean is
/// what makes a padlock a lie. `Unknown` in particular is not a failure: it is
/// the ordinary state of mail from someone whose key you have never fetched,
/// and showing it as broken teaches people to ignore the indicator.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Signature {
    /// The signature is good and the key is one gpg knows.
    Good { key: String, signer: String },
    /// A good signature from a key that has expired, or that signed after it
    /// expired. The mail is authentic; the key is not current.
    Expired { key: String, signer: String },
    /// A good signature from a key that has been revoked. Shown apart from
    /// `Bad` because the message was genuinely signed — by a key its owner has
    /// since disowned, which is a different thing to have happened.
    Revoked { key: String, signer: String },
    /// The bytes do not match the signature. The message was altered, or it was
    /// never signed by the key it claims.
    Bad { key: String },
    /// No public key, so nothing can be concluded either way. The overwhelmingly
    /// common case, and not an error.
    Unknown { key: String },
    /// gpg could not tell us — malformed input, an unsupported algorithm.
    Failed { detail: String },
}

impl Signature {
    /// Whether this is a signature anyone should be reassured by.
    pub fn is_good(&self) -> bool {
        matches!(self, Signature::Good { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unknown is the ordinary state of mail from a stranger, and it is not
    /// good. Anything that treats "we have a Signature" as reassurance is
    /// wrong.
    #[test]
    fn only_a_plainly_good_signature_reassures_anyone() {
        assert!(Signature::Good {
            key: "k".into(),
            signer: "s".into()
        }
        .is_good());
        for other in [
            Signature::Unknown { key: "k".into() },
            Signature::Bad { key: "k".into() },
            Signature::Expired {
                key: "k".into(),
                signer: "s".into(),
            },
            Signature::Revoked {
                key: "k".into(),
                signer: "s".into(),
            },
            Signature::Failed { detail: "d".into() },
        ] {
            assert!(!other.is_good(), "{other:?}");
        }
    }
}
