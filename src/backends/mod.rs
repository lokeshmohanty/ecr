pub mod editor;
pub mod mbsync;
pub mod msmtp;
pub mod notmuch;

use std::process::Command;

pub fn sync_all() -> std::io::Result<()> {
    // Run mbsync -a if available, then notmuch new
    let _ = Command::new("mbsync").arg("-a").status();
    let _ = Command::new("notmuch").arg("new").status();
    Ok(())
}
