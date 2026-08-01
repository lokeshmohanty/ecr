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
      self,
      nixpkgs,
      fenix,
      flake-utils,
      ...
    }:
    # Linux only. The dev shell and the desktop shell are built on WebKitGTK,
    # which has no darwin equivalent here; a macOS build is a v1.0.0 item.
    (flake-utils.lib.eachSystem
      [
        "x86_64-linux"
        "aarch64-linux"
      ]
      (
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

          # Tauri v2 desktop (WebKitGTK) build dependencies. The Android SDK/NDK
          # is deliberately not here — it is a large, opt-in closure and is not
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

          # Linking is not enough: the shell dlopen's a wider set at run time.
          # Without these the binary starts and then dies on a missing
          # libdbus-1.so.3 or renders a blank window.
          tauriRuntime =
            tauriDeps
            ++ (with pkgs; [
              dbus
              at-spi2-core
              at-spi2-atk
              atk
              libxkbcommon
              wayland
              libGL
              mesa
              harfbuzz
              fontconfig
              freetype
              libx11
              libxcursor
              libxrandr
              libxi
              libxcomposite
              libxdamage
              libxext
              libxfixes
              libxcb
            ]);
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
                just # task runner; see the Justfile
                hurl # API-level tests against ecr-server
                jq

                # Licence compliance; see THIRD-PARTY.md and deny.toml
                cargo-deny
                cargo-license
                git-filter-repo
              ])
              ++ mailTools;

            buildInputs = tauriDeps;

            RUST_LOG = "debug";
            RUST_BACKTRACE = "1";

            # WebKitGTK under Nix needs its own compositing mode and loaders
            # resolved explicitly, otherwise the Tauri window renders blank.
            WEBKIT_DISABLE_COMPOSITING_MODE = "1";
            GIO_MODULE_DIR = "${pkgs.glib-networking}/lib/gio/modules";

            LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath tauriRuntime;

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

          packages = rec {
            default = ecr;

            ecr-web = pkgs.callPackage ./nix/web.nix {
              nodejs = pkgs.nodejs_22;
              pnpm = pkgs.pnpm_10;
            };

            ecr = pkgs.callPackage ./nix/ecr.nix {
              inherit ecr-web;
              isync = pkgs.isync;
            };
          };

          checks = {
            inherit (self.packages.${system}) ecr ecr-web;
          };

          apps.default = {
            type = "app";
            program = "${self.packages.${system}.ecr}/bin/ecr";
          };
        }
      )
    )
    // {
      nixosModules.default = import ./nix/module.nix self;
      nixosModules.ecr = self.nixosModules.default;
    };
}
