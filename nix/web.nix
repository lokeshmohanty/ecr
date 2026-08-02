{
  lib,
  stdenv,
  nodejs,
  pnpm,
  version,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "ecr-web";
  inherit version;

  src = lib.fileset.toSource {
    root = ../.;
    # vite.config.ts copies ../licenses/fonts into dist, so the licences are
    # part of the source this derivation needs.
    fileset = lib.fileset.unions [
      ../web/src
      ../web/index.html
      ../web/package.json
      ../web/pnpm-lock.yaml
      ../web/tsconfig.json
      ../web/vite.config.ts
      ../licenses
    ];
  };

  nativeBuildInputs = [
    nodejs
    pnpm.configHook
  ];

  # The version carries the git revision on a `main` build, and the dependency
  # set does not change with every commit. Pinning the name to the lockfile's
  # own version keeps one store path across the channel, instead of a fresh
  # fetch named after each revision.
  pnpmDeps = pnpm.fetchDeps {
    inherit (finalAttrs) pname src;
    version = "lock";
    sourceRoot = "${finalAttrs.src.name}/web";
    fetcherVersion = 2;
    hash = "sha256-nc6cvLEmOuDXizC9Vb6+tYvsvuly37VNI3eRr4jGVdg=";
  };

  pnpmRoot = "web";

  buildPhase = ''
    runHook preBuild
    cd web
    pnpm exec vite build
    cd ..
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r web/dist/* $out/
    runHook postInstall
  '';

  meta = {
    description = "Built SolidJS client for ecr";
    license = lib.licenses.mit;
  };
})
