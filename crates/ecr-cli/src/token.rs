use crate::qr;
use ecr_core::pairing::Pairing;
use ecr_server::auth::TokenStore;
use std::path::Path;

pub fn new(path: &Path, name: &str, with_qr: bool, url: Option<&str>) -> anyhow::Result<()> {
    let mut store = TokenStore::load(path)?;
    let token = store.issue(name)?;
    store.save(path)?;

    println!("{token}");
    eprintln!();
    eprintln!("Saved as \"{name}\" in {}.", path.display());
    eprintln!("This is the only time the token is shown.");

    if with_qr {
        let address = url.map(str::to_string).or_else(reachable_address);
        let pairing = match address {
            Some(url) => Pairing::new(url, &token),
            None => Pairing::token_only(&token),
        };

        eprintln!();
        eprintln!("{}", qr::render(&pairing.to_string())?);

        match &pairing.url {
            Some(url) => eprintln!("Scanning this pairs a phone with {url}."),
            None => eprintln!(
                "This carries the token only, so the address still has to be typed.\n\
                 Pass --url http://<this machine>:8383 to put it in the code as well."
            ),
        }
    }
    Ok(())
}

/// The address to put in a pairing code when none was given.
///
/// `ECR_BIND` is where the server listens, which is not always somewhere a
/// phone can reach: `127.0.0.1` is this machine only and `0.0.0.0` is not an
/// address at all, it is *every* address. Encoding either produces a code that
/// scans cleanly and then cannot connect, which is worse than a code that
/// admits it has no address — so those two are declined and the caller is told
/// to pass `--url`.
fn reachable_address() -> Option<String> {
    let bind = std::env::var("ECR_BIND").ok()?;
    let (host, _) = bind.rsplit_once(':')?;
    let host = host.trim_matches(['[', ']']);

    let unusable = host.is_empty()
        || host == "0.0.0.0"
        || host == "::"
        || host == "127.0.0.1"
        || host == "::1"
        || host == "localhost";

    (!unusable).then(|| format!("http://{bind}"))
}

pub fn list(path: &Path) -> anyhow::Result<()> {
    let store = TokenStore::load(path)?;

    if store.is_empty() {
        println!("no device tokens; the API is unauthenticated");
    }
    for token in &store.tokens {
        println!("{}\t{}", token.name, token.created);
    }
    Ok(())
}

pub fn revoke(path: &Path, name: &str) -> anyhow::Result<()> {
    let mut store = TokenStore::load(path)?;

    if !store.revoke(name) {
        anyhow::bail!("no token named {name}");
    }
    store.save(path)?;
    println!("revoked {name}");
    Ok(())
}
