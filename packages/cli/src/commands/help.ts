// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
export const HELP = `Usage: mongo-manager [command] [options]

Commands:
  start                         Start the web UI (default)
  open [--no-open]              Open a running local-mode Mongo Manager in the browser with a new
                                one-time link (--no-open prints the link instead)
  forget-browsers               Sign every browser out of local mode (each needs a new link)
  user add <username> --role <admin|editor|viewer> [--require-2fa]
                                Create a user (team mode); --require-2fa makes them set up
                                two-factor authentication before anything else
  user reset-password <username>
                                Set a new password and sign the user out everywhere
  user reset-2fa <username>     Remove all two-factor methods of a user
  user list                     List users
  bans list                     List the addresses banned from the sign-in (team mode)
  bans lift <address> | --all   Lift a sign-in ban, or every one
  access list                   List the addresses the team-mode panel answers (none: every one)
  access clear                  Let every address reach the panel again
  rotate-key [--new-key-file <path>]
                                Re-encrypt all stored secrets with a new key (server must be stopped)
  doctor                        Check the installation and the data directory
  service install [--user <name>] [--node <path>] [-p <port>] [--host <address>] [--no-auth] [--no-shell]
                                Install and start as a system service (needs root/Administrator)
  service uninstall             Remove the service; data, config and key are kept (needs root/Administrator)
  service open                  Print a one-time link that opens the service in local mode (needs root/Administrator)
  service status                Show the service state
  service logs [-f]             Show the service log; -f keeps printing new lines (not on Windows)
  backup inspect <file>         List what a backup holds (.archive, .gz, .mmbak or a dump zip)
  backup decrypt <file.mmbak> -o <file.archive>
                                Decrypt a backup into a plain archive mongorestore reads
  backup decrypt <file.mmbak> --key-file <kit.txt> -o <file.archive>
                                Decrypt a scheduled backup with its recovery kit
  version                       Print the version

Options:
  -p, --web-port <port>         Port of the web UI (default 4321; not a MongoDB port)
      --host <address>          Interface to bind (default 127.0.0.1)
      --auth / --no-auth        Team mode with users and sign-in (default off)
      --data-dir <path>         Data directory (default ~/.mongo-manager)
      --config <file>           JSON config file (CLI > env > file > defaults)
      --open / --no-open        Open the browser in local mode (default on; start and open)
      --uri <uri>               Pre-seed one connection on first start (prefer MM_URI: argv is visible to others)
      --read-only               Global read-only mode
      --shell / --no-shell      The in-browser MongoDB shell (default on; MM_SHELL_ENABLED=0 turns it off)
      --trusted-proxies <list>  Comma-separated proxy addresses/CIDRs to trust for X-Forwarded-*
      --allowed-hosts <list>    Comma-separated Host header allow-list
      --base-path <path>        Serve under a sub-path, e.g. /mongo/
      --unsafe-no-auth          Allow a network bind without authentication (dangerous)
      --log-level <level>       fatal, error, warn, info, debug, trace or silent
      --log-file <path>         Append JSON logs to a file (0600) instead of standard output
      --password-stdin          (user, backup) Read the password from standard input
      --key-file <kit.txt>      (backup) Open a backup-key file with its recovery kit
      --key -                   (backup) Read the recovery kit from standard input
  -o, --out <file>              (backup decrypt) The new file to write; never overwritten
  -f, --follow                  (service logs) Keep printing new log lines (not on Windows)
      --all                     (bans lift) Lift every ban
  -h, --help                    Show this help
  -v, --version                 Show the version

Every server option also has an MM_* environment variable, e.g. MM_WEB_PORT, MM_AUTH=1, MM_SECRET_KEY.
`
