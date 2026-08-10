//! Discovery, against a server that answers the way real ones do.
//!
//! Both of these pin behaviour that no unit test over the XML can reach: what
//! the HTTP client does with a redirect, and how many round trips discovery
//! costs. Each is a thing that fails silently — a redirect handled wrongly ends
//! at "named no principal", and an extra home-set lookup is invisible until a
//! provider answers one of them with an error.

use ecr_store::dav::{discover, Kind};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

/// One request as the server saw it.
struct Seen {
    method: String,
    path: String,
    body: String,
}

/// A server that answers each request from `replies` in order, and reports what
/// it was asked. Runs on its own thread; the port comes back down the channel.
fn serve(replies: Vec<String>) -> (u16, mpsc::Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (send, receive) = mpsc::channel();

    std::thread::spawn(move || {
        for reply in replies {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().unwrap());

            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or_default().to_string();
            let path = parts.next().unwrap_or_default().to_string();

            let mut length = 0usize;
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                if header.trim().is_empty() {
                    break;
                }
                if let Some(value) = header.to_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).unwrap();

            send.send(Seen {
                method,
                path,
                body: String::from_utf8_lossy(&body).to_string(),
            })
            .unwrap();

            stream.write_all(reply.as_bytes()).unwrap();
            stream.flush().unwrap();
        }
    });

    (port, receive)
}

/// `Connection: close` throughout: the client pools connections, and a server
/// that answers one request per accepted socket would otherwise be handed a
/// reused one it never reads.
fn xml(body: &str) -> String {
    format!(
        "HTTP/1.1 207 Multi-Status\r\nContent-Type: application/xml\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

/// The requests the server saw, in order. Waits for each rather than draining
/// what has arrived: the reply is written after the request is recorded, so a
/// non-blocking drain races the last one and reports a round trip as missing.
fn requests(seen: &mpsc::Receiver<Seen>, count: usize) -> Vec<Seen> {
    (0..count)
        .map(|n| {
            seen.recv_timeout(std::time::Duration::from_secs(5))
                .unwrap_or_else(|_| panic!("only {n} request(s) arrived, wanted {count}"))
        })
        .collect()
}

const PRINCIPAL: &str = r#"<?xml version="1.0"?>
<multistatus xmlns="DAV:"><response><href>/dav/</href>
<propstat><prop><current-user-principal><href>/dav/alice/</href></current-user-principal></prop></propstat>
</response></multistatus>"#;

/// The home set hrefs are in the `DAV:` namespace even though the property
/// around them is not — a prefixed declaration rather than a default one, which
/// is what every real server sends and what makes the two distinguishable.
const HOMES: &str = r#"<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav" xmlns:l="urn:ietf:params:xml:ns:caldav">
<response><href>/dav/alice/</href><propstat><prop>
<c:addressbook-home-set><href>/dav/alice/contacts/</href></c:addressbook-home-set>
<l:calendar-home-set><href>/dav/alice/calendars/</href></l:calendar-home-set>
</prop></propstat></response></multistatus>"#;

const CONTACT_COLLECTIONS: &str = r#"<?xml version="1.0"?>
<multistatus xmlns="DAV:"><response><href>/dav/alice/contacts/default/</href><propstat><prop>
<resourcetype><collection/><addressbook xmlns="urn:ietf:params:xml:ns:carddav"/></resourcetype>
<displayname>Personal</displayname></prop></propstat></response></multistatus>"#;

/// RFC 6764 discovery *is* a redirect: Google and Fastmail both answer
/// `.well-known/carddav` with a 301 to the real resource. An HTTP client that
/// turns the PROPFIND into a GET — which is what browsers do with a 301, and
/// what several clients therefore implement — follows it to a resource that
/// answers with something other than a multistatus, and discovery ends at
/// "named no principal" while naming a URL that is perfectly correct.
#[tokio::test]
async fn a_redirect_is_followed_as_propfind_with_its_body() {
    let (port, seen) = serve(vec![
        "HTTP/1.1 301 Moved Permanently\r\nLocation: /dav/\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
            .to_string(),
        xml(PRINCIPAL),
        xml(HOMES),
        xml(CONTACT_COLLECTIONS),
    ]);

    let client = reqwest::Client::new();
    let found = discover(
        &client,
        &format!("http://127.0.0.1:{port}/.well-known/carddav"),
        "Bearer x",
        &[Kind::Contacts],
    )
    .await
    .unwrap();

    let asked = requests(&seen, 2);
    let (first, after) = (&asked[0], &asked[1]);

    assert_eq!(first.path, "/.well-known/carddav");
    assert_eq!(after.method, "PROPFIND", "the redirect changed the method");
    assert_eq!(after.path, "/dav/");
    assert!(
        after.body.contains("current-user-principal"),
        "the redirect dropped the body: {:?}",
        after.body
    );

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "Personal");
}

/// Google's CalDAV answers `current-user-principal` with a `404 Not Found`
/// *inside* an otherwise perfectly good `207`, because the URL it documents —
/// `/caldav/v2/<address>/user` — is already the principal and has nothing to
/// point at. Treating that as fatal ends discovery with "named no principal"
/// against the one URL Google tells you to use, while the very next request for
/// `calendar-home-set` answers `200` at that same URL. This is not a mock of a
/// hypothetical server: it is Google's response, byte for byte.
#[tokio::test]
async fn a_base_that_names_no_principal_is_the_principal() {
    const NO_PRINCIPAL: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:"><D:response><D:href>/caldav/v2/alice@gmail.com/user</D:href>
<D:propstat><D:status>HTTP/1.1 404 Not Found</D:status><D:prop><D:current-user-principal/></D:prop></D:propstat>
</D:response></D:multistatus>"#;

    const CALENDARS: &str = r#"<?xml version="1.0"?>
<multistatus xmlns="DAV:"><response><href>/caldav/v2/alice/events/</href><propstat><prop>
<resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>
<displayname>Work</displayname></prop></propstat></response></multistatus>"#;

    let homes = r#"<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:l="urn:ietf:params:xml:ns:caldav">
<response><href>/caldav/v2/alice/user</href><propstat><prop>
<l:calendar-home-set><href>/caldav/v2/alice/</href></l:calendar-home-set>
</prop></propstat></response></multistatus>"#;

    let (port, seen) = serve(vec![xml(NO_PRINCIPAL), xml(homes), xml(CALENDARS)]);

    let client = reqwest::Client::new();
    let found = discover(
        &client,
        &format!("http://127.0.0.1:{port}/caldav/v2/alice/user"),
        "Bearer x",
        &[Kind::Calendar],
    )
    .await
    .unwrap();

    let asked = requests(&seen, 3);
    assert_eq!(
        asked[1].path, "/caldav/v2/alice/user",
        "the home set was asked of something other than the base"
    );
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "Work");
    assert_eq!(found[0].kind, Kind::Calendar);
}

/// Google serves CardDAV and CalDAV from different hosts, so each base is asked
/// for one kind. Asking a contacts host for a `calendar-home-set` is a round
/// trip that can only come back empty — and against a server that answers an
/// unknown home set with an error rather than an absence, it is a failure
/// reported for a collection nobody asked about.
#[tokio::test]
async fn asking_for_one_kind_visits_only_that_home_set() {
    let (port, seen) = serve(vec![xml(PRINCIPAL), xml(HOMES), xml(CONTACT_COLLECTIONS)]);

    let client = reqwest::Client::new();
    let found = discover(
        &client,
        &format!("http://127.0.0.1:{port}/dav/"),
        "Bearer x",
        &[Kind::Contacts],
    )
    .await
    .unwrap();

    let paths: Vec<String> = requests(&seen, 3)
        .into_iter()
        .map(|request| request.path)
        .collect();

    assert_eq!(paths, vec!["/dav/", "/dav/alice/", "/dav/alice/contacts/"]);
    assert!(
        seen.recv_timeout(std::time::Duration::from_millis(200))
            .is_err(),
        "the calendar home set was fetched for a contacts-only discovery"
    );

    assert_eq!(found.len(), 1);
    assert!(found.iter().all(|c| c.kind == Kind::Contacts));
}

/// A vCard, answered to a `GET` of one item.
fn vcard(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/vcard\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

/// The listing every run of the collection answers, unchanged between them.
const LISTING: &str = r#"<?xml version="1.0"?>
<multistatus xmlns="DAV:">
<response><href>/dav/alice/contacts/default/</href>
<propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>
<response><href>/dav/alice/contacts/default/one.vcf</href>
<propstat><prop><getetag>"v1"</getetag><resourcetype/></prop></propstat></response>
<response><href>/dav/alice/contacts/default/two.vcf</href>
<propstat><prop><getetag>"v1"</getetag><resourcetype/></prop></propstat></response>
</multistatus>"#;

/// The whole point of reading the etags: a collection that has not changed
/// costs one `PROPFIND`, not one request per item.
///
/// Without this, every pass re-downloaded every contact and every event —
/// measured at ten and a half minutes against a real Google account, every
/// fifteen minutes, to write nothing. That is invisible in the log, which says
/// `(0 changed)` either way; the only symptom is a sync that never settles. So
/// what is asserted here is the request count, which is the thing that was
/// wrong, rather than the files on disk, which were always right.
#[tokio::test]
async fn an_unchanged_collection_is_not_downloaded_again() {
    let (port, seen) = serve(vec![
        xml(LISTING),
        vcard("BEGIN:VCARD\nFN:One\nEND:VCARD"),
        vcard("BEGIN:VCARD\nFN:Two\nEND:VCARD"),
        xml(LISTING),
        // Spare replies: if the second pass wrongly refetches, it gets these
        // and the assertion below names how many extra requests it made.
        vcard("BEGIN:VCARD\nFN:One\nEND:VCARD"),
        vcard("BEGIN:VCARD\nFN:Two\nEND:VCARD"),
    ]);

    let root = tempfile::tempdir().unwrap();
    let client = reqwest::Client::new();
    let collection = ecr_store::dav::Collection {
        kind: Kind::Contacts,
        url: format!("http://127.0.0.1:{port}/dav/alice/contacts/default/"),
        name: "Personal".into(),
    };

    let first = ecr_store::dav::sync_collection(&client, &collection, "Bearer t", root.path())
        .await
        .unwrap();
    assert_eq!(first, 2, "both contacts should be written the first time");

    let second = ecr_store::dav::sync_collection(&client, &collection, "Bearer t", root.path())
        .await
        .unwrap();
    assert_eq!(second, 0, "nothing changed, so nothing is rewritten");

    let methods: Vec<String> = requests(&seen, 4).into_iter().map(|r| r.method).collect();
    assert_eq!(
        methods,
        vec!["PROPFIND", "GET", "GET", "PROPFIND"],
        "the second pass must list and stop"
    );

    assert!(
        seen.recv_timeout(std::time::Duration::from_millis(500))
            .is_err(),
        "the second pass fetched an item whose etag had not changed"
    );

    // And the files are still there to be read, which is what the skip risks.
    let one = root.path().join("contacts/Personal/one.vcf");
    assert!(one.is_file(), "{} is missing", one.display());
}
