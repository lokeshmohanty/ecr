{
  lib,
  rustPlatform,
  pkg-config,
  wrapGAppsHook3,
  ecr-web,
  version,

  openssl,
  webkitgtk_4_1,
  gtk3,
  libsoup_3,
  glib-networking,
  librsvg,
  cairo,
  pango,
  gdk-pixbuf,
  glib,
  dbus,
  at-spi2-atk,
  atk,
}:

rustPlatform.buildRustPackage (finalAttrs: {
  pname = "ecr-desktop";
  inherit version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../crates
      ../shell
      # web/ itself is deliberately absent: the client is built by the ecr-web
      # derivation and dropped into web/dist below. Including web/src as well
      # would put a second, unbuilt copy in the sandbox for shell/build.rs to
      # find newer than dist, and it would then try to run pnpm with no network.
      ../packaging
    ];
  };

  cargoLock.lockFile = ../Cargo.lock;

  cargoBuildFlags = [
    "-p"
    "ecr-desktop"
  ];

  # The workspace's tests belong to the server crates and are run by the `ecr`
  # derivation, which does not drag in any of WebKitGTK. Running them again here
  # would build that closure for nothing.
  doCheck = false;

  # `tauri::generate_context!` embeds frontendDist — `../web/dist` — into the
  # binary at compile time. It has to exist before cargo runs, and the mtimes
  # have to be newer than anything under web/src, or shell/build.rs decides the
  # bundle is stale and shells out to a pnpm that is not in the sandbox.
  preBuild = ''
    mkdir -p web/dist
    cp -r ${ecr-web}/. web/dist/
    chmod -R u+w web/dist
    find web/dist -exec touch {} +
  '';

  nativeBuildInputs = [
    pkg-config
    wrapGAppsHook3
  ];

  buildInputs = [
    openssl
    webkitgtk_4_1
    gtk3
    libsoup_3
    glib-networking
    librsvg
    cairo
    pango
    gdk-pixbuf
    glib
    dbus
    at-spi2-atk
    atk
  ];

  # The same three files the deb installs, at the same names — `ecr.desktop`
  # because that is what Tauri's bundler calls the entry it generates from this
  # very file, and `ecr-desktop.png` because that is what it calls the icons.
  # The two names differ: the entry is named after `productName` and the icons
  # after the binary. Naming the icons `ecr` here would leave this package the
  # only one whose artwork the `Icon=` key in that shared entry does not find.
  postInstall = ''
    install -Dm644 packaging/ecr.desktop $out/share/applications/ecr.desktop
    install -Dm644 packaging/dev.lokeshmohanty.ecr.metainfo.xml \
      $out/share/metainfo/dev.lokeshmohanty.ecr.metainfo.xml

    for pair in 32:32x32 128:128x128 256:128x128@2x 512:icon; do
      size="''${pair%%:*}"
      file="''${pair##*:}"
      install -Dm644 "shell/icons/$file.png" \
        "$out/share/icons/hicolor/''${size}x''${size}/apps/ecr-desktop.png"
    done
  '';

  # WebKitGTK under Nix renders a blank window without its own compositing mode,
  # and TLS fails without the glib-networking GIO modules resolved explicitly —
  # the same two variables the dev shell sets.
  preFixup = ''
    gappsWrapperArgs+=(
      --set WEBKIT_DISABLE_COMPOSITING_MODE 1
      --set GIO_MODULE_DIR ${glib-networking}/lib/gio/modules
    )
  '';

  meta = {
    description = "Desktop client for ecr";
    homepage = "https://github.com/lokeshmohanty/ecr";
    license = lib.licenses.mit;
    mainProgram = "ecr-desktop";
    platforms = lib.platforms.linux;
  };
})
