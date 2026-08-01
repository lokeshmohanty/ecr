use crate::qr;
use ecr_server::auth::TokenStore;
use std::path::Path;

pub fn new(path: &Path, name: &str, with_qr: bool) -> anyhow::Result<()> {
    let mut store = TokenStore::load(path)?;
    let token = store.issue(name)?;
    store.save(path)?;

    println!("{token}");
    eprintln!();
    eprintln!("Saved as \"{name}\" in {}.", path.display());
    eprintln!("This is the only time the token is shown.");

    if with_qr {
        eprintln!();
        eprintln!("{}", qr::render(&token)?);
    }
    Ok(())
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
