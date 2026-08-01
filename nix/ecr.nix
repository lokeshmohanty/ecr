{
  lib,
  rustPlatform,
  pkg-config,
  openssl,
  makeWrapper,
  ecr-web,
  notmuch,
  isync,
  msmtp,
}:

rustPlatform.buildRustPackage (finalAttrs: {
  pname = "ecr";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../crates
      # A workspace member, so cargo needs it present to resolve at all. Only
      # ecr-cli is actually built, so none of the WebKitGTK closure is linked.
      ../shell
      # The integration tests build a throwaway notmuch database from these.
      ../fixtures
    ];
  };

  cargoLock.lockFile = ../Cargo.lock;

  # The desktop shell is a workspace member and pulls in the whole WebKitGTK
  # closure. A headless install must never link it, so only the CLI is built.
  cargoBuildFlags = [
    "-p"
    "ecr-cli"
  ];
  cargoTestFlags = [
    "-p"
    "ecr-core"
    "-p"
    "ecr-store"
    "-p"
    "ecr-server"
    "-p"
    "ecr-cli"
  ];

  nativeBuildInputs = [
    pkg-config
    makeWrapper
  ];
  buildInputs = [ openssl ];

  # The integration tests drive the real notmuch binary against a tempdir, and
  # the doctor tests assert a healthy setup, which means all three on PATH.
  nativeCheckInputs = [
    notmuch
    isync
    msmtp
  ];

  postInstall = ''
    mkdir -p $out/share/ecr
    cp -r ${ecr-web} $out/share/ecr/web

    # ecr-store shells out to these; without them on PATH `ecr doctor` fails and
    # the server refuses to start.
    wrapProgram $out/bin/ecr \
      --prefix PATH : ${
        lib.makeBinPath [
          notmuch
          isync
          msmtp
        ]
      }
  '';

  meta = {
    description = "A keyboard-driven mail client for an existing notmuch maildir";
    homepage = "https://github.com/lokeshmohanty/ecr";
    license = with lib.licenses; [
      mit
      asl20
    ];
    mainProgram = "ecr";
    platforms = lib.platforms.unix;
  };
})
