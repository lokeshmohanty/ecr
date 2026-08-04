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

          # Two channels are published from this repository — `release`, which
          # CI moves to each tag, and `main`. Both can sit at the same Cargo
          # version for weeks, so the version alone cannot say which one is
          # installed and the revision has to be part of it. `ecr --version`
          # reports this string, and so does `nix profile list`.
          # Both fall back rather than throwing: `self` carries a revision and a
          # timestamp for the ordinary case of a flake fetched from git, but
          # neither is guaranteed — a `path:` input, or a tree with no git, has
          # no revision, and reading a missing attribute here would fail the
          # evaluation of every consumer's configuration rather than of this
          # file alone.
          cargoVersion = (builtins.fromTOML (builtins.readFile ./Cargo.toml)).workspace.package.version;
          revision = self.shortRev or self.dirtyShortRev or "unknown";
          stamp = builtins.substring 0 8 (self.lastModifiedDate or "00000000");
          version = "${cargoVersion}+${stamp}.${revision}";

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

          # The Android SDK is unfree and its licence has to be accepted, so it
          # gets its own nixpkgs rather than loosening the one every other build
          # goes through. It is a multi-gigabyte closure: nothing but
          # `nix develop .#android` ever evaluates this.
          androidPkgs = import nixpkgs {
            inherit system;
            config = {
              allowUnfree = true;
              android_sdk.accept_license = true;
            };
          };

          # Gradle asks the SDK for whatever the Tauri template names — `compileSdk
          # 36` as of tauri-cli 2.9 — and a Nix SDK is read-only, so it cannot
          # download a missing piece. Carrying the three current platform and
          # build-tools pairs is what keeps a `tauri android init` from a newer
          # CLI from failing at the first Gradle sync.
          ndkVersion = "27.3.13750724";
          buildToolsVersion = "36.0.0";
          androidSdk = androidPkgs.androidenv.composeAndroidPackages {
            platformVersions = [
              "34"
              "35"
              "36"
            ];
            buildToolsVersions = [
              "34.0.0"
              "35.0.0"
              buildToolsVersion
            ];
            includeNDK = true;
            inherit ndkVersion;
            includeEmulator = false;
            includeSystemImages = false;
          };
          androidRoot = "${androidSdk.androidsdk}/libexec/android-sdk";

          # Rust builds the shell's cdylib for the phone, so the toolchain needs
          # the Android std. arm64 is every real device; x86_64 is the emulator.
          rustAndroid = pkgs.fenix.combine [
            rustToolchain
            pkgs.fenix.targets."aarch64-linux-android".stable.rust-std
            pkgs.fenix.targets."x86_64-linux-android".stable.rust-std
          ];

          # Tauri v2 desktop (WebKitGTK) build dependencies. The Android SDK/NDK
          # is deliberately not in the default shell — it is a large, opt-in
          # closure; `nix develop .#android` is where it lives.
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

          # Everything but the Rust toolchain, which differs between the two
          # shells: the Android one carries the phone's std as well.
          devTools =
            (with pkgs; [
              pkg-config

              # Web client
              nodejs_22
              pnpm

              # Tooling
              sqlite # inspecting the ecr-store cache
              just # task runner; see the Justfile
              hurl # API-level tests against ecr-server
              jq
              zola # the documentation site under docs/
              librsvg # rsvg-convert, for `just icons` and the store metadata

              # Licence compliance; see THIRD-PARTY.md and deny.toml
              cargo-deny
              cargo-license
              git-filter-repo
            ])
            ++ mailTools;
        in
        {
          devShells.default = pkgs.mkShell {
            name = "ecr";

            packages = [ rustToolchain ] ++ devTools;

            buildInputs = tauriDeps;

            RUST_LOG = "debug";
            RUST_BACKTRACE = "1";
            SASL_PATH = saslPath;

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

          # Opt-in: `nix develop .#android`, or just run `just android`, which
          # enters this shell for you. The default shell plus the SDK, the NDK,
          # a JDK, adb and the Tauri CLI. The server still runs on this machine,
          # so the mail tools have to be here too — hence devTools, not a
          # freestanding Android-only shell.
          devShells.android = pkgs.mkShell {
            name = "ecr-android";

            packages = devTools ++ [
              rustAndroid # the host toolchain plus the phone's std
              androidSdk.androidsdk
              androidSdk.platform-tools # adb
              pkgs.cargo-tauri
              pkgs.jdk17
            ];

            buildInputs = tauriDeps;

            RUST_LOG = "debug";
            RUST_BACKTRACE = "1";
            SASL_PATH = saslPath;

            ANDROID_HOME = androidRoot;
            ANDROID_SDK_ROOT = androidRoot;
            NDK_HOME = "${androidRoot}/ndk/${ndkVersion}";
            JAVA_HOME = "${pkgs.jdk17}";

            # Gradle resolves aapt2 from a Maven artifact and then tries to
            # execute it: a prebuilt binary that cannot run on NixOS. Point it
            # at the SDK's own patched copy or every build dies in resource
            # linking.
            GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidRoot}/build-tools/${buildToolsVersion}/aapt2";

            LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath tauriRuntime;

            shellHook = ''
              echo "ecr android shell"
              echo "  sdk   $ANDROID_HOME"
              echo "  ndk   $NDK_HOME"
              echo "  adb   $(adb --version 2>/dev/null | head -1)"
              echo
              echo "  just android   # build, install and run on a connected device"
            '';
          };

          packages = rec {
            default = ecr;

            ecr-web = pkgs.callPackage ./nix/web.nix {
              inherit version;
              nodejs = pkgs.nodejs_22;
              pnpm = pkgs.pnpm_10;
            };

            ecr = pkgs.callPackage ./nix/ecr.nix {
              inherit ecr-web version;
              isync = pkgs.isync;
            };

            ecr-desktop = pkgs.callPackage ./nix/desktop.nix {
              inherit ecr-web version;
            };

            # The browser the visual suite runs, exposed so that `nix build
            # .#visual-browser` resolves it through *this* flake's pinned
            # nixpkgs rather than through the floating registry. Two chromium
            # builds rasterise glyphs differently, and the whole point is that
            # CI and a laptop produce the same pixels.
            visual-browser = pkgs.ungoogled-chromium;

            # The font set the visual suite renders with.
            #
            # Written out rather than built with `makeFontsConf`, which appends
            # `/etc/fonts/conf.d`, `/usr/share/fonts` and the user profile to
            # whatever it is given. That is right for a desktop and fatal here:
            # both machines then render with their *own* fonts on top of the
            # pinned ones, which is how a gear icon came out as a colour emoji
            # on one and a monochrome glyph on the other. Nothing outside this
            # list is reachable.
            visual-fonts = pkgs.writeText "ecr-visual-fonts.conf" ''
              <?xml version="1.0"?>
              <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
              <fontconfig>
                <dir>${pkgs.dejavu_fonts}/share/fonts</dir>
                <dir>${pkgs.noto-fonts}/share/fonts</dir>
                <dir>${pkgs.noto-fonts-color-emoji}/share/fonts</dir>
                <cachedir prefix="xdg">fontconfig</cachedir>

                <!-- The client bundles the faces it actually uses; these only
                     decide what a fallback glyph lands on. -->
                <alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
                <alias><family>serif</family><prefer><family>DejaVu Serif</family></prefer></alias>
                <alias><family>monospace</family><prefer><family>DejaVu Sans Mono</family></prefer></alias>
              </fontconfig>
            '';
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

      homeManagerModules.default = import ./nix/hm-module.nix self;
      homeManagerModules.ecr = self.homeManagerModules.default;
    };
}
