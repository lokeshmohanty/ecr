use std::path::Path;
use std::process::Command;
use std::time::SystemTime;

fn main() {
    // `default_token` reads this through `option_env!`, so it is baked in at
    // compile time and cargo would otherwise reuse a binary carrying the old
    // one. That only bites the Android build, where the value cannot arrive any
    // other way, and it bites silently: the phone presents a revoked token and
    // the app looks like it cannot reach the server.
    println!("cargo:rerun-if-env-changed=ECR_TOKEN");

    rebuild_web_if_stale();
    tauri_build::build()
}

/// `cargo run -p ecr-desktop` embeds `web/dist` at compile time via
/// `tauri::generate_context!`, but cargo does not run `beforeBuildCommand` —
/// only the Tauri CLI does. Without this, a stale dist silently ships old
/// JavaScript and the user wonders why a fix had no effect.
fn rebuild_web_if_stale() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let web = Path::new(&manifest).join("../web");
    let dist = web.join("dist/index.html");

    println!("cargo:rerun-if-changed=../web/src");

    let dist_mtime = match dist.metadata().and_then(|m| m.modified()) {
        Ok(m) => m,
        Err(_) => {
            println!("cargo:warning=web/dist not found; run `just build-web`");
            return;
        }
    };

    if !any_newer(&web.join("src"), dist_mtime) {
        return;
    }

    match Command::new("pnpm")
        .args(["--dir", &web.to_string_lossy(), "build"])
        .status()
    {
        Ok(s) if s.success() => {}
        Ok(s) => panic!("web build failed (status {s}); run `just build-web`"),
        Err(_) => {
            println!(
                "cargo:warning=pnpm not found; run `just build-web` to rebuild the web client"
            );
        }
    }
}

fn any_newer(dir: &Path, cutoff: SystemTime) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if any_newer(&path, cutoff) {
                return true;
            }
        } else if let Ok(meta) = entry.metadata() {
            if let Ok(mtime) = meta.modified() {
                if mtime > cutoff {
                    return true;
                }
            }
        }
    }
    false
}
