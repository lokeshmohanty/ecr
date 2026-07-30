{
  description = "Vim Email Client: A Rust GUI email manager with vim-like keybindings";

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
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ fenix.overlays.default ];
        };

        # Rust toolchain: stable with extras
        rustToolchain = pkgs.fenix.stable.withComponents [
          "cargo"
          "clippy"
          "rust-src"
          "rustc"
          "rustfmt"
          "rust-analyzer"
        ];

        # Combined toolchain with WASM target
        fullToolchain = pkgs.fenix.combine [
          rustToolchain
          pkgs.fenix.targets.wasm32-unknown-unknown.stable.rust-std
        ];


      in
      {
        devShells.default = pkgs.mkShell {
          name = "vim-email-client";

          packages = [
            fullToolchain
            pkgs.pkg-config
          ];

          buildInputs = with pkgs; [
            # Wayland
            wayland
            libxkbcommon

            # X11
            libx11
            libxcursor
            libxrandr
            libxi

            # OpenGL
            libGL

            # Vulkan (for wgpu backend)
            vulkan-loader
          ];

          RUST_LOG = "debug";
          RUST_BACKTRACE = "1";

          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
            pkgs.wayland
            pkgs.libxkbcommon
            pkgs.libGL
            pkgs.vulkan-loader
            pkgs.libx11
            pkgs.libxcursor
            pkgs.libxrandr
            pkgs.libxi
          ];

          shellHook = ''
            echo "📧 Vim Email Client dev environment"
          '';
        };

      }
    );
}

