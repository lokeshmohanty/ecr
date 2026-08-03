const OVERVIEW: &str = "\
ecr — a mail client

  Getting started
    ecr doctor              check the mail setup; everything else depends on it
    ecr serve               run the server and print the address to open

  Every day
    ecr serve --read-only   run against real mail with every write refused

  Devices
    ecr token new <name>    issue a device token, once
    ecr token list          name and date of every issued token
    ecr token revoke <name> withdraw one

  Topics
    ecr help start          a first run, from nothing to reading mail
    ecr help phone          reaching your mail from a phone
    ecr help accounts       where accounts and addresses come from
    ecr help trouble        what to check when something is wrong
";

const START: &str = "\
A first run

  ecr needs notmuch, mbsync and msmtp configured, plus whatever your config
  invokes to authenticate. It reads their configuration rather than owning it.

    1. ecr doctor
       Reports the config each tool resolved to and how it was found, the
       maildir root, the database, every account and its token state. It names
       a fix for anything broken. The server refuses to start until this is
       healthy.

    2. ecr serve
       Prints the address to open. The web client is served from the same
       origin, so opening that address is the whole app.

  With no device tokens issued the API is unauthenticated, which is what you
  want while it is bound to localhost. Issue one before binding anywhere else.
";

const PHONE: &str = "\
Reaching your mail from a phone

  The server binds one address. Bind it to a tailnet address, not the public
  internet — this is a mail store, and it has no TLS of its own.

    ecr serve --bind 100.83.12.4:8383
    ecr token new phone --qr

  The token is printed once. Enter the server address in the client on the
  phone, then the token.

  Do not expose this to the internet without TLS and a reverse proxy in front.
";

const ACCOUNTS: &str = "\
Where accounts come from

  Every directory under the maildir root is an account. The root itself comes
  from notmuch's database.path, never from a guess.

  An account's address is resolved from the mbsync channel that syncs into its
  directory, falling back to the msmtp account of the same name. That is why
  `ecr doctor` prints the channel next to each account: no channel means no
  address, and no address means replies cannot pick the right identity.

  Nothing about accounts is configured in ecr. Fix the mail tools' config and
  ecr follows.

  Gmail and Outlook will not take a password. `ecr oauth` is the exception to
  the paragraph above — it holds the OAuth profile itself:

    ecr oauth setup main --provider gmail --email you@gmail.com

  then point the mail tools at it, and the token refreshes on demand:

    PassCmd \"ecr oauth token main\"      # mbsyncrc
    passwordeval ecr oauth token main   # msmtp
";

const TROUBLE: &str = "\
When something is wrong

  Start with `ecr doctor`. It names the failure and the fix for most of these.

  Server refuses to start
    The setup is not healthy. Read the report it printed.

  Empty inbox, no error
    The query. `/api/v1/threads?q=*` should return everything.

  503 from the API
    A binary is missing from the server's PATH. Pin absolute paths in
    ~/.config/ecr/server.toml — worth doing under systemd, where PATH is bare.

  Sync fails to authenticate
    Check the token state in `ecr doctor`. For Gmail and Outlook,
    `ecr oauth status <profile>` says why, and `ecr oauth authorize <profile>`
    runs the flow again.

  New mail never appears
    Was the server started with --no-watch? Otherwise check the log for
    watcher warnings.

  Tagging silently does nothing
    `notmuch tag --batch` exits 0 on malformed input, so ecr validates before
    writing. A 400 here is ecr refusing a bad tag, which is the intent.
";

pub fn run(topic: Option<&str>) -> anyhow::Result<()> {
    let page = match topic {
        None => OVERVIEW,
        Some("start") => START,
        Some("phone") => PHONE,
        Some("accounts") => ACCOUNTS,
        Some("trouble") => TROUBLE,
        Some(other) => anyhow::bail!(
            "no help topic named {other}.\n\n  Topics: start, phone, accounts, trouble\n"
        ),
    };

    print!("{page}");
    Ok(())
}
