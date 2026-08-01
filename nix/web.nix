{
  lib,
  stdenv,
  nodejs,
  pnpm,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "ecr-web";
  version = "0.1.0";

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

  pnpmDeps = pnpm.fetchDeps {
    inherit (finalAttrs) pname version src;
    sourceRoot = "${finalAttrs.src.name}/web";
    fetcherVersion = 2;
    hash = "sha256-1PfZEhJsGUAoDOnOfuDF9G6sZ805xztXg4NQUKVbEHo=";
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
    license = with lib.licenses; [
      mit
      asl20
    ];
  };
})
