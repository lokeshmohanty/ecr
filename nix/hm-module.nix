self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.ecr;
  packages = self.packages.${pkgs.stdenv.hostPlatform.system};
in
{
  options.programs.ecr = {
    enable = lib.mkEnableOption "the ecr mail client";

    package = lib.mkOption {
      type = lib.types.package;
      default = packages.ecr;
      defaultText = lib.literalMD "the flake's `ecr` package";
      description = ''
        The server and CLI. Which channel this is depends on the flake input:
        `github:lokeshmohanty/ecr` follows `main`, `github:lokeshmohanty/ecr/release`
        follows the newest release. `ecr --version` reports the revision, so the
        two are always tellable apart.
      '';
    };

    desktop = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Also install `ecr-desktop`, the Tauri client, with its desktop entry and
        icons. This links WebKitGTK; leave it off on a headless machine.
      '';
    };

    desktopPackage = lib.mkOption {
      type = lib.types.package;
      default = packages.ecr-desktop;
      defaultText = lib.literalMD "the flake's `ecr-desktop` package";
      description = "The desktop client to install when `desktop` is set.";
    };

    server = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Run `ecr serve` as a systemd *user* service. A user service rather
          than a system one because the maildir, the notmuch database and every
          config ecr reads live in this user's home, and Xapian writes there.
        '';
      };

      bind = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1:8383";
        example = "100.64.0.1:8383";
        description = ''
          Address to listen on. With no tokens issued the API is
          unauthenticated, so anything other than a loopback or tailnet address
          wants `ecr token new` first.
        '';
      };

      readOnly = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Refuse every write: no tagging, syncing or sending.";
      };

      extraArgs = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "--no-watch" ];
        description = "Further arguments for `ecr serve`.";
      };

      environment = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        example = {
          RUST_LOG = "info";
        };
        description = "Extra environment for the service.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ] ++ lib.optional cfg.desktop cfg.desktopPackage;

    systemd.user.services.ecr = lib.mkIf cfg.server.enable {
      Unit = {
        Description = "ecr mail server";
        Documentation = "https://github.com/lokeshmohanty/ecr/tree/main/docs";
        After = [ "network-online.target" ];
        Wants = [ "network-online.target" ];

        # Wide enough that `RestartSec` below can fill the burst. systemd's
        # default window is 10s, which five restarts five seconds apart can
        # never fill, so a permanent failure — the bind address already taken
        # is the one that happens — retries forever and never reaches `failed`.
        # Nothing then reports it: the unit looks activating, not broken.
        StartLimitIntervalSec = 300;
        StartLimitBurst = 5;
      };

      Service = {
        ExecStart = lib.escapeShellArgs (
          [
            (lib.getExe cfg.package)
            "serve"
            "--bind"
            cfg.server.bind
          ]
          ++ lib.optional cfg.server.readOnly "--read-only"
          ++ cfg.server.extraArgs
        );
        Restart = "on-failure";
        RestartSec = 5;

        # The package wraps `ecr` so notmuch, mbsync and msmtp are on PATH
        # already; anything a user's own mbsync or msmtp config shells out to —
        # an OAuth helper, typically — is not, and a user unit inherits nothing
        # from the login shell.
        Environment = lib.mapAttrsToList (k: v: "${k}=${v}") cfg.server.environment;

        NoNewPrivileges = true;
        PrivateTmp = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
      };

      Install.WantedBy = [ "default.target" ];
    };
  };
}
