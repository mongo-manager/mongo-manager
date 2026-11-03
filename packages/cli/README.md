<h1 align="center">Mongo Manager</h1>

<p align="center"><b>A secure MongoDB manager that runs in your browser, on a server you host.</b><br>
Use it alone or with your team, let an AI agent do the work in your own words, and keep everything fully offline.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mongo-manager/app"><img src="https://img.shields.io/npm/v/@mongo-manager/app?logo=npm&label=npm&color=CB3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@mongo-manager/app"><img src="https://img.shields.io/npm/dm/@mongo-manager/app?color=CB3837" alt="npm downloads"></a>
  <a href="https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml"><img src="https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/mongo-manager/mongo-manager/releases"><img src="https://img.shields.io/github/v/release/mongo-manager/mongo-manager?logo=github&label=release" alt="GitHub release"></a>
  <a href="https://github.com/mongo-manager/mongo-manager/pkgs/container/mongo-manager"><img src="https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white" alt="Docker image on ghcr.io"></a>
  <br>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24 or newer"></a>
  <a href="https://www.mongodb.com/"><img src="https://img.shields.io/badge/MongoDB-6.0%2B-47A248?logo=mongodb&logoColor=white" alt="MongoDB 6.0 or newer"></a>
  <img src="https://img.shields.io/badge/languages-10-0A7EA4" alt="Ten interface languages">
  <img src="https://img.shields.io/badge/works-offline-2EA44F" alt="Works fully offline">
  <a href="https://github.com/mongo-manager/mongo-manager/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-lightgrey" alt="License: CC BY-NC-SA 4.0"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mongo-manager/mongo-manager/main/docs/media/clips/ai.gif" alt="The AI agent: an answer from the data, and an index waiting for confirmation" width="760">
</p>

<p align="center">
  <a href="https://github.com/mongo-manager/mongo-manager#readme"><b>Every feature</b></a> ·
  <a href="https://mongo-manager.github.io/mongo-manager/"><b>Website</b></a> ·
  <a href="https://github.com/mongo-manager/mongo-manager/tree/main/deploy"><b>Deploy</b></a> ·
  <a href="https://github.com/mongo-manager/mongo-manager/blob/main/CHANGELOG.md"><b>Changelog</b></a>
</p>

## Why Mongo Manager

- **For a whole team, from a browser.** One install on a server; users, roles, access per connection, two-factor sign-in and an audit log.
- **An AI agent that asks first.** Your own provider (Anthropic, Gemini, any OpenAI-compatible server or Ollama). It answers from your data and changes nothing until you confirm.
- **The everyday MongoDB work.** Documents, aggregations stage by stage, schema, query plans, indexes, live performance, replica sets and sharded clusters.
- **Backups and live sync.** Scheduled, encrypted backups to S3, Google Drive, WebDAV or a server folder; continuous copies with a verified cutover.
- **Personal data stays hidden** by rules, on every screen, in exports, backups and the AI.
- **Fully offline.** No telemetry, no CDN, no external fonts, and no update check unless an administrator turns on the daily one.

<table>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/mongo-manager/mongo-manager/main/site/assets/screens/documents-light.png" alt="Documents in a table, with a filter and one-click suggestions"><br><sub>Documents, with a filter and one-click suggestions</sub></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/mongo-manager/mongo-manager/main/site/assets/screens/aggregation-light.png" alt="An aggregation pipeline, each stage previewed"><br><sub>A pipeline, each stage previewed</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/mongo-manager/mongo-manager/main/site/assets/screens/performance-light.png" alt="Live server performance"><br><sub>Live server performance</sub></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/mongo-manager/mongo-manager/main/site/assets/screens/schema-light.png" alt="The schema of a sampled collection"><br><sub>The schema of a sampled collection</sub></td>
  </tr>
</table>

## What's new

**1.1.0**

- Updates from the panel: the About page finds a newer signed release (by hand, or once a day when an administrator turns it on) and installs it with Update; a version that does not start is rolled back. Install 1.1.0 by hand once.
- A collection opens with its newest documents first.
- A pinned database or collection names its connection.

**1.0.2**

- Bundled plugin files kept in the data folder are checked and read through one open file, so nothing put at their names after the check is taken for them.

**1.0.1**

- The standalone binaries carry their bundled plugins again.
- SQL import and export come with the SQL → MongoDB plugin: an administrator turns it on in Plugins.
- In Docker, the connection form explains that `localhost` is the container itself and switches the host to `host.docker.internal` in one click; the deployment guide covers the reverse proxy, the setup token and reaching MongoDB from the container.

All changes: [CHANGELOG.md](https://github.com/mongo-manager/mongo-manager/blob/main/CHANGELOG.md).

## Install

```sh
npx @mongo-manager/app                 # try it
npm install --global @mongo-manager/app
```

Offline or air-gapped: copy the release tarball and install it. It has no dependencies and runs no install scripts.

```sh
npm install --global ./mongo-manager-<version>.tgz
```

Requires Node.js 24 or newer. Without Node.js: the standalone binaries for Windows, macOS and Linux are on the
[releases page](https://github.com/mongo-manager/mongo-manager/releases), and the Docker image (tagged by version) runs in team mode:

```sh
docker run -d --name mongo-manager -p 127.0.0.1:4321:4321 -v mm-data:/data ghcr.io/mongo-manager/mongo-manager:1.1.0
docker exec mongo-manager cat /data/setup-token   # the one-time setup token
```

## Use

```sh
mongo-manager                     # local mode on http://127.0.0.1:4321, opens your browser
mongo-manager --auth              # team mode: users, roles, two-factor sign-in
mongo-manager --help              # all commands and options
```

| Command                                        | Purpose                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `start`                                        | Start the web UI (the default command)                                          |
| `open [--no-open]`                             | Open a running local-mode Mongo Manager with a new one-time link                |
| `forget-browsers`                              | Sign every browser out of local mode (each then needs a new link)               |
| `user add <name> --role admin\|editor\|viewer` | Create a user                                                                   |
| `user reset-password <name>`                   | Set a new password and sign the user out everywhere                             |
| `user reset-2fa <name>`                        | Remove a user's two-factor methods (admin recovery)                             |
| `user list`                                    | List users                                                                      |
| `bans list`                                    | List the addresses banned from the team-mode sign-in                            |
| `bans lift <address>` / `bans lift --all`      | Lift a sign-in ban (your own address, without a session), or every one          |
| `access list`                                  | List the addresses the team-mode panel answers (an empty list: every address)   |
| `access clear`                                 | Let every address reach the panel again (an administrator locked out)           |
| `rotate-key`                                   | Re-encrypt all stored secrets with a new key. Stop the server first.            |
| `doctor`                                       | Check the installation and the data directory                                   |
| `service install`                              | Run as a system service that starts with the machine (root or Administrator)    |
| `service uninstall`                            | Remove the service; data, config and key are kept (root or Administrator)       |
| `service status\|logs [-f]`                    | Show the service state, or its log (`-f` follows it; not on Windows)            |
| `service open`                                 | Print a one-time link that opens the service in local mode (root or Admin)      |
| `backup inspect <file>`                        | List what a backup file holds                                                   |
| `backup decrypt <file.mmbak> -o <file>`        | Decrypt an encrypted backup into a plain archive that `mongorestore` can read   |
| `backup decrypt … --key-file <kit.txt>`        | The same for a scheduled backup sealed with a backup key, with its recovery kit |
| `version`                                      | Print the version                                                               |

Every server option also has an `MM_*` environment variable, for example `MM_WEB_PORT`, `MM_AUTH=1` or `MM_DATA_DIR`.

## On a server

Team mode, behind a reverse proxy that serves HTTPS (nginx, Caddy):

```sh
mongo-manager --auth --host 127.0.0.1 --trusted-proxies 127.0.0.1 --allowed-hosts mongo.example.com
```

The first start prints a one-time setup token; open the address and create the first administrator.
Ready-made nginx and Caddy configurations, the system service and Docker are described in
[deploy/](https://github.com/mongo-manager/mongo-manager/tree/main/deploy). Use `--base-path /mongo/`
to serve it under a sub-path.

## Security notes

- **Listening address.** Mongo Manager listens on `127.0.0.1` by default. It refuses to listen on a network address without `--auth`.
- **Data directory.** Everything lives in the data directory (default `~/.mongo-manager`, mode 0700):
  - the database;
  - the encryption key `secret.key` (mode 0600). You can supply the key instead through `MM_SECRET_KEY`;
  - in local mode, `launch.key` (mode 0600): the secret the one-time launch links are made from. Only a browser that opened such a link can use local mode; delete the file while Mongo Manager is stopped to sign every browser out.

  Back up the data directory and the key together. Without the key, saved connection passwords cannot be decrypted.

- **Passwords on the command line.** Never pass passwords as command-line arguments; other users can see them in the process list.
  - `user` commands prompt for the password, or read it with `--password-stdin`.
  - Use `MM_URI` rather than `--uri` for a connection string that contains a password.

## License

[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)](https://github.com/mongo-manager/mongo-manager/blob/main/LICENSE):
free to use, share and adapt with credit, not for commercial purposes, and shared under the same
license. Bundled third-party components keep their own licenses (`dist/THIRD-PARTY-NOTICES.txt`).

## Author

**Gokhan OZGEZER** · [gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com) · [GitHub](https://github.com/gokhanozgezer) ·
[Issues](https://github.com/mongo-manager/mongo-manager/issues)
