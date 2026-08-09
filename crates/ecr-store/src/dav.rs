//! CardDAV and CalDAV, without a sync tool.
//!
//! vdirsyncer used to be the answer to "where do contacts come from", and it is
//! a second program with a second configuration file and a second idea of where
//! things live. Both protocols are WebDAV with two extra reports, and ecr
//! already has an HTTP client, a TLS stack and the OAuth token that Gmail and
//! Outlook want for them — so the whole of what ecr needs is a `PROPFIND`, a
//! `REPORT`, and a `GET` per item.
//!
//! What is stored is a **vdir**: one file per contact or event, in a directory
//! per collection. That is the format vdirsyncer wrote and that khard and khal
//! read, so this replaces the sync tool without replacing anybody's data or
//! locking it up somewhere only ecr can reach.
//!
//! Read-only, deliberately and for now. Fetching somebody's address book cannot
//! lose anything; writing to it can, and an address book is not backed up the
//! way a maildir is.

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Where a collection lives, and what it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Collection {
    pub kind: Kind,
    /// The absolute URL of the collection on the server.
    pub url: String,
    /// What the server calls it. Used as the directory name, so it is made safe
    /// for a filesystem first.
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Contacts,
    Calendar,
}

impl Kind {
    fn extension(&self) -> &'static str {
        match self {
            Kind::Contacts => "vcf",
            Kind::Calendar => "ics",
        }
    }

    fn dir(&self) -> &'static str {
        match self {
            Kind::Contacts => "contacts",
            Kind::Calendar => "calendars",
        }
    }
}

/// One item fetched from a collection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// The href, relative or absolute, which is also what names the file.
    pub href: String,
    pub body: String,
}

/// The `PROPFIND` body that asks a collection what it holds.
const LIST_BODY: &str = r#"<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>"#;

/// Every item href in a collection.
///
/// `Depth: 1`, which is the collection and its children — the alternative is
/// `infinity`, which many servers refuse outright and the rest answer slowly.
pub async fn list(client: &reqwest::Client, url: &str, auth: &str) -> Result<Vec<String>> {
    let response = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), url)
        .header("Depth", "1")
        .header("Content-Type", "application/xml; charset=utf-8")
        .header("Authorization", auth)
        .body(LIST_BODY)
        .send()
        .await
        .map_err(|err| Error::Managed(format!("could not reach {url}: {err}")))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| Error::Managed(format!("{url} answered unreadably: {err}")))?;

    if !status.is_success() {
        return Err(Error::Managed(format!("{url} answered {status}")));
    }

    Ok(hrefs(&text))
}

/// The item hrefs in a WebDAV multistatus response.
///
/// Parsed rather than pattern-matched: `d:` is a convention and not a
/// guarantee, so this matches on the namespaced local name, which is what the
/// specification actually fixes.
pub fn hrefs(xml: &str) -> Vec<String> {
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        return Vec::new();
    };

    doc.descendants()
        .filter(|node| node.has_tag_name((DAV, "response")))
        .filter(|response| {
            // The collection itself comes back as one of its own children, and
            // fetching it as an item gets a directory listing where a vCard
            // should be.
            !response
                .descendants()
                .any(|n| n.has_tag_name((DAV, "collection")))
        })
        .filter_map(|response| {
            response
                .descendants()
                .find(|n| n.has_tag_name((DAV, "href")))
                .and_then(|n| n.text())
                .map(str::to_string)
        })
        .collect()
}

const DAV: &str = "DAV:";

/// Fetches one item.
pub async fn fetch(client: &reqwest::Client, url: &str, auth: &str) -> Result<String> {
    let response = client
        .get(url)
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|err| Error::Managed(format!("could not fetch {url}: {err}")))?;

    if !response.status().is_success() {
        return Err(Error::Managed(format!(
            "{url} answered {}",
            response.status()
        )));
    }

    response
        .text()
        .await
        .map_err(|err| Error::Managed(format!("{url} answered unreadably: {err}")))
}

/// Writes a collection to a vdir.
///
/// One file per item, named from the href, in a directory named for the
/// collection — the layout vdirsyncer wrote, so khard and khal read what ecr
/// fetches without being told anything.
pub fn write_vdir(root: &Path, collection: &Collection, items: &[Item]) -> Result<usize> {
    let dir = root
        .join(collection.kind.dir())
        .join(safe_name(&collection.name));
    std::fs::create_dir_all(&dir)?;

    let mut written = 0;
    for item in items {
        let name = format!(
            "{}.{}",
            safe_name(&item_id(&item.href)),
            collection.kind.extension()
        );
        let path = dir.join(name);

        // Only when it differs, so a resync does not rewrite an entire address
        // book's mtimes and wake everything watching the directory.
        if std::fs::read_to_string(&path).ok().as_deref() == Some(item.body.as_str()) {
            continue;
        }
        std::fs::write(&path, &item.body)?;
        written += 1;
    }

    Ok(written)
}

/// The last path segment of an href, without its extension.
fn item_id(href: &str) -> String {
    let last = href
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(href);
    match last.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => last.to_string(),
    }
}

/// A filename that cannot escape its directory or surprise a filesystem.
///
/// An href is server-controlled, and one containing `../` would otherwise write
/// wherever it liked.
fn safe_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '@' => c,
            _ => '-',
        })
        .collect();

    let trimmed = cleaned.trim_matches(['.', '-']).to_string();
    if trimmed.is_empty() {
        "item".to_string()
    } else {
        trimmed
    }
}

/// Where the vdirs live.
pub fn vdir_root(state_dir: &Path) -> PathBuf {
    state_dir.to_path_buf()
}

/// The `Authorization` header for an account.
///
/// A password account gets Basic, which is what every DAV server that is not
/// Google or Microsoft expects — and it is safe here for the same reason it is
/// safe in IMAP: the connection is TLS, and a header is the only place these
/// protocols carry a credential at all.
pub async fn authorization(
    profiles: &crate::oauth::Profiles,
    account: &ecr_core::managed::ManagedAccount,
) -> Result<String> {
    use base64::Engine;

    match &account.auth {
        ecr_core::managed::Auth::Oauth { profile } => Ok(format!(
            "Bearer {}",
            crate::oauth::access_token(profiles, profile).await?
        )),
        ecr_core::managed::Auth::Command { command } => {
            let (program, args) = command
                .split_first()
                .ok_or_else(|| Error::Managed("the password command is empty".into()))?;

            let output = tokio::process::Command::new(program)
                .args(args)
                .output()
                .await
                .map_err(|err| {
                    Error::Managed(format!("the password command could not be run: {err}"))
                })?;

            if !output.status.success() {
                return Err(Error::Managed(format!(
                    "the password command exited with {}",
                    output.status
                )));
            }

            // The first line only. A password manager that prints the password
            // and then a block of metadata is the normal case, and sending the
            // metadata as part of the credential fails as a bad password.
            let text = String::from_utf8_lossy(&output.stdout);
            let password = text.lines().next().unwrap_or_default();

            Ok(format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{password}", account.address))
            ))
        }
    }
}

/// The `PROPFIND` that asks a server who we are.
const PRINCIPAL_BODY: &str = r#"<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#;

/// The one that asks where this principal's collections are kept.
const HOMES_BODY: &str = r#"<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"
            xmlns:l="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:addressbook-home-set/><l:calendar-home-set/></d:prop>
</d:propfind>"#;

/// The one that asks a home set what collections it holds, and their names.
const COLLECTIONS_BODY: &str = r#"<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>"#;

const CARDDAV: &str = "urn:ietf:params:xml:ns:carddav";
const CALDAV: &str = "urn:ietf:params:xml:ns:caldav";

async fn propfind(
    client: &reqwest::Client,
    url: &str,
    auth: &str,
    depth: &str,
    body: &'static str,
) -> Result<String> {
    let response = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), url)
        .header("Depth", depth)
        .header("Content-Type", "application/xml; charset=utf-8")
        .header("Authorization", auth)
        .body(body)
        .send()
        .await
        .map_err(|err| Error::Managed(format!("could not reach {url}: {err}")))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| Error::Managed(format!("{url} answered unreadably: {err}")))?;

    if !status.is_success() {
        return Err(Error::Managed(format!("{url} answered {status}")));
    }
    Ok(text)
}

/// Finds the collections of the given kinds, starting from one URL.
///
/// Three round trips, which is what the protocol costs: who am I, where are my
/// collections, and what is in there. Each step is separate because each fails
/// differently — a wrong password stops at the first, and a server with no
/// address book at all stops at the second with nothing wrong.
///
/// `kinds` is a parameter rather than always both because a provider may serve
/// the two protocols from different hosts (Google does), and asking one of them
/// for the other's home set is a round trip that can only come back empty.
pub async fn discover(
    client: &reqwest::Client,
    base: &str,
    auth: &str,
    kinds: &[Kind],
) -> Result<Vec<Collection>> {
    // A base that does not answer `current-user-principal` **is** the principal.
    //
    // Google's CalDAV is the case that matters: it answers the property with a
    // `404 Not Found` inside an otherwise perfectly good `207`, because the URL
    // it documents — `/caldav/v2/<address>/user` — is already the principal and
    // there is nothing to point at. Treating that as a failure ends discovery
    // with "named no principal" against the one URL Google says to use, while
    // the very next request for `calendar-home-set` answers `200` at that same
    // URL. Falling through costs a wrong base nothing: it finds no home set
    // either, and an empty result is what a server with no collections gives.
    let xml = propfind(client, base, auth, "0", PRINCIPAL_BODY).await?;
    let principal = first_href(&xml, DAV, "current-user-principal")
        .map(|href| absolute(base, &href))
        .unwrap_or_else(|| base.to_string());

    let homes = propfind(client, &principal, auth, "0", HOMES_BODY).await?;
    let mut found = Vec::new();

    for kind in kinds {
        let (ns, tag) = match kind {
            Kind::Contacts => (CARDDAV, "addressbook-home-set"),
            Kind::Calendar => (CALDAV, "calendar-home-set"),
        };
        let Some(home) = first_href(&homes, ns, tag) else {
            continue;
        };
        let home = absolute(base, &home);

        let listing = propfind(client, &home, auth, "1", COLLECTIONS_BODY).await?;
        found.extend(collections(&listing, *kind, base));
    }

    Ok(found)
}

/// The first href inside a named property.
fn first_href(xml: &str, namespace: &str, tag: &str) -> Option<String> {
    let doc = roxmltree::Document::parse(xml).ok()?;
    doc.descendants()
        .find(|n| n.has_tag_name((namespace, tag)))?
        .descendants()
        .find(|n| n.has_tag_name((DAV, "href")))?
        .text()
        .map(str::to_string)
}

/// The collections of one kind in a home set listing.
fn collections(xml: &str, kind: Kind, base: &str) -> Vec<Collection> {
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        return Vec::new();
    };

    let marker = match kind {
        Kind::Contacts => (CARDDAV, "addressbook"),
        Kind::Calendar => (CALDAV, "calendar"),
    };

    doc.descendants()
        .filter(|n| n.has_tag_name((DAV, "response")))
        // A home set contains collections of both kinds and itself. Only the
        // ones carrying the right resourcetype are this kind's.
        .filter(|response| response.descendants().any(|n| n.has_tag_name(marker)))
        .filter_map(|response| {
            let href = response
                .descendants()
                .find(|n| n.has_tag_name((DAV, "href")))?
                .text()?;

            let name = response
                .descendants()
                .find(|n| n.has_tag_name((DAV, "displayname")))
                .and_then(|n| n.text())
                .filter(|n| !n.trim().is_empty())
                .map(str::to_string)
                // A collection with no display name still has a URL, and the
                // last segment of it is what every other client falls back to.
                .unwrap_or_else(|| item_id(href));

            Some(Collection {
                kind,
                url: absolute(base, href),
                name,
            })
        })
        .collect()
}

/// Resolves an href against the server it came from.
///
/// Servers answer with a path far more often than a URL, and joining it to the
/// *base* rather than to the request URL is what keeps a principal at `/dav/`
/// from being resolved under `/dav/alice/contacts/`.
pub fn absolute(base: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    let origin = match base.split_once("://") {
        Some((scheme, rest)) => {
            let host = rest.split('/').next().unwrap_or(rest);
            format!("{scheme}://{host}")
        }
        None => base.trim_end_matches('/').to_string(),
    };
    format!(
        "{}/{}",
        origin.trim_end_matches('/'),
        href.trim_start_matches('/')
    )
}

/// Fetches every item in a collection and writes the vdir.
pub async fn sync_collection(
    client: &reqwest::Client,
    collection: &Collection,
    auth: &str,
    root: &Path,
) -> Result<usize> {
    let hrefs = list(client, &collection.url, auth).await?;

    let mut items = Vec::with_capacity(hrefs.len());
    for href in hrefs {
        let url = absolute(&collection.url, &href);
        match fetch(client, &url, auth).await {
            Ok(body) => items.push(Item { href, body }),
            // One unreadable contact must not cost the other four hundred.
            Err(err) => tracing::debug!(%url, %err, "skipping an item that could not be fetched"),
        }
    }

    write_vdir(root, collection, &items)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MULTISTATUS: &str = r#"<?xml version="1.0"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/dav/alice/contacts/</href>
    <propstat><prop><resourcetype><collection/><addressbook xmlns="urn:ietf:params:xml:ns:carddav"/></resourcetype></prop></propstat>
  </response>
  <response>
    <href>/dav/alice/contacts/one.vcf</href>
    <propstat><prop><getetag>"1"</getetag><resourcetype/></prop></propstat>
  </response>
  <response>
    <href>/dav/alice/contacts/two.vcf</href>
    <propstat><prop><getetag>"2"</getetag><resourcetype/></prop></propstat>
  </response>
</multistatus>"#;

    /// The collection comes back as one of its own children. Fetching it as an
    /// item gets a directory listing where a vCard should be.
    #[test]
    fn the_collection_itself_is_not_one_of_its_items() {
        let found = hrefs(MULTISTATUS);
        assert_eq!(
            found,
            vec!["/dav/alice/contacts/one.vcf", "/dav/alice/contacts/two.vcf"]
        );
    }

    /// `d:` is a convention, not a guarantee. A server using a different prefix
    /// for the DAV namespace answers exactly the same document.
    #[test]
    fn a_different_namespace_prefix_parses_the_same() {
        let xml = MULTISTATUS
            .replace(
                "<multistatus xmlns=\"DAV:\">",
                "<D:multistatus xmlns:D=\"DAV:\">",
            )
            .replace("</multistatus>", "</D:multistatus>")
            .replace("<response>", "<D:response>")
            .replace("</response>", "</D:response>")
            .replace("<href>", "<D:href>")
            .replace("</href>", "</D:href>")
            .replace("<propstat>", "<D:propstat>")
            .replace("</propstat>", "</D:propstat>")
            .replace("<prop>", "<D:prop>")
            .replace("</prop>", "</D:prop>")
            .replace("<resourcetype>", "<D:resourcetype>")
            .replace("</resourcetype>", "</D:resourcetype>")
            .replace("<resourcetype/>", "<D:resourcetype/>")
            .replace("<collection/>", "<D:collection/>")
            .replace("<getetag>", "<D:getetag>")
            .replace("</getetag>", "</D:getetag>");

        assert_eq!(hrefs(&xml).len(), 2, "{xml}");
    }

    #[test]
    fn nonsense_is_no_items_rather_than_an_error() {
        assert!(hrefs("not xml at all <<<").is_empty());
    }

    /// An href is the server's to choose, and one containing a traversal would
    /// otherwise write outside the vdir.
    #[test]
    fn an_href_cannot_write_outside_its_directory() {
        assert_eq!(safe_name(&item_id("/dav/../../etc/passwd")), "passwd");
        assert_eq!(safe_name(&item_id("/dav/a/../../../x.vcf")), "x");
        assert_eq!(safe_name(".."), "item");
        assert_eq!(safe_name("/"), "item");
    }

    #[test]
    fn a_vdir_is_one_file_per_item() {
        let dir = tempfile::tempdir().unwrap();
        let collection = Collection {
            kind: Kind::Contacts,
            url: "https://dav.example/alice/contacts/".into(),
            name: "Personal".into(),
        };
        let items = vec![
            Item {
                href: "/dav/alice/contacts/one.vcf".into(),
                body: "BEGIN:VCARD\nEND:VCARD\n".into(),
            },
            Item {
                href: "/dav/alice/contacts/two.vcf".into(),
                body: "BEGIN:VCARD\nEND:VCARD\n".into(),
            },
        ];

        assert_eq!(write_vdir(dir.path(), &collection, &items).unwrap(), 2);
        assert!(dir.path().join("contacts/Personal/one.vcf").is_file());
        assert!(dir.path().join("contacts/Personal/two.vcf").is_file());

        // A second pass writes nothing: an address book that rewrote every file
        // on every sync would wake everything watching the directory.
        assert_eq!(write_vdir(dir.path(), &collection, &items).unwrap(), 0);
    }
}
