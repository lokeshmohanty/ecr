{
  description = "ecr — a client/server mail client: Rust axum server over notmuch, SolidJS clients";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
  };

  nixConfig = {
    extra-substituters = [ "https://lokeshmohanty.cachix.org" ];
    extra-trusted-public-keys = [
      "lokeshmohanty.cachix.org-1:XkCPbX2XsKzlr0P/MecvqruyTeOA8SzJzwMcCOfuLuI="
    ];
  };

  outputs =
    {
      nixpkgs,
      fenix,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ fenix.overlays.default ];
        };

        rustToolchain = pkgs.fenix.stable.withComponents [
          "cargo"
          "clippy"
          "rust-src"
          "rustc"
          "rustfmt"
          "rust-analyzer"
        ];

        # Runtime tools the server shells out to. These must be on PATH for
        # `ecr-server doctor`, the ecr-store integration tests and the running
        # server itself — their absence is why the previous implementation
        # could never talk to any mail.
        mailTools = with pkgs; [
          notmuch
          isync # provides `mbsync`
          msmtp
        ];

        # Tauri v2 desktop (WebKitGTK) dependencies. The Android SDK/NDK is
        # deliberately not here — it is a large, opt-in closure and is not
        # needed until the Android shell phase.
        tauriDeps = with pkgs; [
          webkitgtk_4_1
          gtk3
          libsoup_3
          glib-networking
          librsvg
          cairo
          pango
          gdk-pixbuf
          glib
          openssl
        ];
      in
      {
        devShells.default = pkgs.mkShell {
          name = "ecr";

          packages =
            (with pkgs; [
              rustToolchain
              pkg-config

              # Web client
              nodejs_22
              pnpm

              # Tooling
              sqlite # inspecting the ecr-store cache
              hurl # API-level tests against ecr-server
              jq
            ])
            ++ mailTools;

          buildInputs = tauriDeps;

          RUST_LOG = "debug";
          RUST_BACKTRACE = "1";

          # WebKitGTK under Nix needs its own compositing mode and loaders
          # resolved explicitly, otherwise the Tauri window renders blank.
          WEBKIT_DISABLE_COMPOSITING_MODE = "1";
          GIO_MODULE_DIR = "${pkgs.glib-networking}/lib/gio/modules";

          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath tauriDeps;

          shellHook = ''
            echo "ecr dev shell"
            echo "  notmuch $(notmuch --version 2>/dev/null | head -1)"
            echo "  mbsync  $(mbsync --version 2>/dev/null | head -1)"
            echo "  msmtp   $(msmtp --version 2>/dev/null | head -1)"
            echo "  node    $(node --version)"
            echo
            echo "  cargo run -p ecr-server -- doctor   # verify the mail setup"
          '';
        };
      }
    );
}
