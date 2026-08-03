self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.ecr;
in
{
  options.services.ecr = {
    enable = lib.mkEnableOption "the ecr mail server";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.ecr;
      defaultText = lib.literalMD "the flake's `ecr` package";
      description = "The ecr package to run.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      description = ''
        The user to run as. This must be the user whose maildir and notmuch
        database are being served — ecr reads the config that user's notmuch,
        mbsync and msmtp already use, and there is no separate state of its own
        to isolate into a system account.
      '';
    };

    bind = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1:8383";
      example = "100.64.0.1:8383";
      description = ''
        Address to listen on. With no tokens issued the API is unauthenticated,
        so anything other than a loopback or tailnet address wants
        `ecr token new` first.
      '';
    };

    readOnly = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Refuse every write: no tagging, syncing or sending.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the bind port. Off by default deliberately.";
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

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.user != "";
        message = "services.ecr.user must name the user whose maildir is served.";
      }
    ];

    systemd.services.ecr = {
      description = "ecr mail server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = cfg.environment;

      # Wide enough that `RestartSec` below can fill the burst. systemd's
      # default window is 10s, which five restarts five seconds apart can never
      # fill, so a permanent failure — the bind address already taken is the one
      # that happens — retries forever and never reaches `failed`. Nothing then
      # reports it: the unit looks activating, not broken.
      startLimitIntervalSec = 300;
      startLimitBurst = 5;

      serviceConfig = {
        ExecStart = lib.escapeShellArgs (
          [
            (lib.getExe cfg.package)
            "serve"
            "--bind"
            cfg.bind
          ]
          ++ lib.optional cfg.readOnly "--read-only"
        );
        User = cfg.user;
        Restart = "on-failure";
        RestartSec = 5;

        # The maildir and the notmuch database live in the user's home, and
        # Xapian needs to write there, so ProtectHome cannot be enabled.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
          "~@resources"
        ];
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [
      (lib.toInt (lib.last (lib.splitString ":" cfg.bind)))
    ];
  };
}
