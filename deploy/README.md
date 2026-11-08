# Deploying Mongo Manager

Mongo Manager is one self-contained package. It works without internet access, and it can run in three ways:

- as a system service (recommended on a server);
- in a container;
- in the foreground (`mongo-manager start`).

## Security rules for any deployment

- **Use team mode (`--auth`)** whenever anyone other than you can reach the port. Services and the Docker image default to it.
- **Behind a reverse proxy:**
  - trust only the proxy with `--trusted-proxies 127.0.0.1` (or the proxy's address; for Docker, the network's gateway: see [Docker](#docker));
  - list the public name with `--allowed-hosts mm.example.com`;
  - bind Mongo Manager to `127.0.0.1`.
- **Keys and backups:**
  - The secret key encrypts saved connection passwords. Back it up together with the data directory: without the key, a backup cannot be decrypted.
  - Keep the two apart in storage: whoever has both can read every saved password.

## As a system service

```sh
# Linux / macOS
sudo mongo-manager service install            # team mode on 127.0.0.1:4321
sudo mongo-manager service install -p 8080 --host 0.0.0.0
mongo-manager service status
mongo-manager service logs -f
sudo mongo-manager service uninstall          # keeps data, config and key

# Windows (elevated prompt)
mongo-manager service install
```

|         | Linux (systemd)                       | macOS (launchd)                                          | Windows (Task Scheduler)                                                       |
| ------- | ------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Runs as | system user `mongo-manager`           | hidden account `_mongomanager`                           | `LocalService`                                                                 |
| Program | `/opt/mongo-manager/app`              | `/Library/Application Support/Mongo Manager/app`         | `%ProgramFiles%\Mongo Manager\app`                                             |
| Config  | `/etc/mongo-manager/config.json`      | `/Library/Application Support/Mongo Manager/config.json` | `%ProgramData%\Mongo Manager\config.json`                                      |
| Data    | `/var/lib/mongo-manager` (0700)       | `…/Mongo Manager/data` (0700)                            | `%ProgramData%\Mongo Manager\data` (ACL: SYSTEM, Administrators, LocalService) |
| Key     | `/etc/mongo-manager/env` (root, 0600) | `secret.key` in the data directory                       | `secret.key` in the data directory                                             |
| Logs    | `journalctl -u mongo-manager`         | `/Library/Logs/Mongo Manager/`                           | `%ProgramData%\Mongo Manager\logs\`                                            |

- **First start:** the one-time setup token is kept in `setup-token` in the data directory, never in the log; `service install` prints the command that reads it.
  - The file is removed once the first administrator exists.
  - The token works once: finish the setup right after installing.
- **Local mode (`--no-auth`):** the service opens only from a one-time launch link, made from `launch.key` in the data directory. `service install` prints one, and `sudo mongo-manager service open` (an elevated prompt on Windows) prints a new one. Open it in your own browser, which then stays in; the journal only ever gets the path of a file that opens it, readable by the service's account and administrators. `mongo-manager forget-browsers` signs every browser out.
- **Upgrade:** install the new package, then run `service install` again. Your config, key and data are kept, and only the options you pass change.
- **Standalone binary:** `sudo ./mongo-manager service install` (or `mongo-manager.exe service install` on Windows) copies that one file to `app/bin/` and the service runs it directly. No Node.js is involved.
- **Node.js (npm package):** any Node.js 24+ works for installing, including one from nvm.
  - The installer copies the Node it runs with into the program folder (`app/bin/node`, or `node.exe` on Windows). The service only ever runs that copy.
  - Only administrators can change the copy, and the installer checks this.
  - To upgrade the service's Node, run `service install` again with the newer Node. `--node <path>` copies a different binary instead.
- **Windows account:** the task runs as `LocalService`, which Windows shares with some built-in services. Any of them that is compromised could read the data folder, `secret.key` and `launch.key` (the local-mode launch secret) included. A dedicated virtual account (`NT SERVICE\...`) is not used: Task Scheduler cannot run a task as one. Where that matters, run Mongo Manager in Docker or on a dedicated host.
- **Windows state folder:** `%ProgramData%\Mongo Manager` must be created by the installer or by an administrator. If another user created it first, the installer refuses to use it and changes nothing; move it aside and run the installer again.

The hardened systemd unit (`systemd/mongo-manager.service`) and the launchd plist (`launchd/`) are the exact files that `service install` writes. They are here for manual installs.

## Docker

The image runs Mongo Manager in **team mode** (`MM_AUTH=1`): everyone signs in, and the first start asks for a one-time setup token. Inside the container it listens on every address, `0.0.0.0:4321` (`MM_HOST=0.0.0.0`), runs as uid 10001, keeps everything in the `/data` volume (`MM_DATA_DIR=/data`) and never opens a browser (`MM_OPEN=0`).

### Behind an HTTPS reverse proxy (recommended on a server)

Publish the port on the host's loopback only, and let a reverse proxy on the host (see [Reverse proxy](#reverse-proxy)) serve it over HTTPS under its name:

```sh
docker run -d --name mongo-manager --restart unless-stopped \
  -p 127.0.0.1:4321:4321 \
  -e MM_ALLOWED_HOSTS=mongo.example.com \
  -e MM_TRUSTED_PROXIES=172.17.0.1 \
  -v mm-data:/data \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  ghcr.io/mongo-manager/mongo-manager:<version>
```

- **`MM_ALLOWED_HOSTS`**: the names people open it by. Without this list the container answers only to IP addresses and `localhost` (each start says so), and a request by a name gets `403 Host not allowed`. That holds for anything reaching it by a name: a proxy forwarding the public name, another container by its name (a Prometheus scraping `mongo-manager:4321`), a Kubernetes service. Once the list is set, only the names on it are accepted: add `127.0.0.1` (`MM_ALLOWED_HOSTS=mongo.example.com,127.0.0.1`) to keep opening `http://127.0.0.1:4321` on the server itself.
- **`MM_TRUSTED_PROXIES`**: the address the proxy's requests come from. A proxy on the host reaches the container from the Docker network's gateway, never from `127.0.0.1`: on the default bridge network that is usually `172.17.0.1`. Find it with:

  ```sh
  docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'
  ```

  For a container on a network of its own, inspect that network instead (the compose file fixes its gateway at `172.31.240.1`). A proxy that runs in a container on the same network is trusted by that container's address.

  Without a trusted proxy, every request seems to come from the gateway: the audit log records that address instead of the user's, sign-in bans cannot tell users apart (a private address is never banned, so all clients share one throttle), and session cookies are not marked Secure, because the server cannot tell a request came over HTTPS. Every process on the host can claim a forwarded address through the gateway, so keep the port on the loopback.

- **`--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true`**: the same hardening the compose file applies (`read_only`, `tmpfs: /tmp`, `cap_drop: [ALL]`, `no-new-privileges`). Mongo Manager writes only to `/data` and `/tmp`.

### First start

The one-time setup token is kept in `/data/setup-token`, never in the log; the container's log (`docker logs mongo-manager`) names the file. Read it and finish the setup right away, at `https://mongo.example.com` (or `http://127.0.0.1:4321` on the host): until the first administrator exists, whoever has the token can become the administrator. The file is removed once the first administrator exists.

```sh
docker exec mongo-manager cat /data/setup-token
```

### Reaching your MongoDB from the container

Inside a container, `localhost` is the container itself, so a connection to `mongodb://localhost:27017` fails with `ECONNREFUSED` even when MongoDB runs on the same machine. Connect by an address the container can reach:

- **MongoDB in another container:** put both containers on one Docker network and connect by the MongoDB container's name, `mongodb://my-mongodb:27017`:

  ```sh
  docker network create mm
  docker network connect mm mongo-manager
  docker network connect mm my-mongodb
  ```

  Or start both with `--network mm`; in a compose file, put both services on one network (the compose file here does that for its `with-mongo` profile). Its port does not need to be published on the host at all.

- **MongoDB on the host, Docker Desktop (Windows, macOS):** connect to `mongodb://host.docker.internal:27017`.
- **MongoDB on the host, Linux:** either
  - run Mongo Manager on the host's network with `--network host` instead of `-p`. Then `localhost` is the host, and `mongodb://localhost:27017` works. Keep it private with `-e MM_HOST=127.0.0.1` (it would otherwise listen on every address of the host), put the reverse proxy in front, and trust it with `MM_TRUSTED_PROXIES=127.0.0.1`; or
  - add `--add-host=host.docker.internal:host-gateway` and connect to `mongodb://host.docker.internal:27017`. This reaches only a MongoDB that listens on the bridge's gateway address (its `bindIp`), and that the host's firewall lets the container reach. A MongoDB listening only on the host's `127.0.0.1` cannot be reached this way, and neither can a MongoDB container published only on the host's loopback (`-p 127.0.0.1:27018:27017`): put that one on a shared network or use the host network.

A replica set names its members itself: if they are named `localhost:27017`, the driver follows those names after the first contact and fails again. Add `?directConnection=true` to talk to the one member, or name the members by an address the container can reach.

### Docker Compose

```sh
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml exec mongo-manager cat /data/setup-token   # one-time setup token
```

The compose file builds the image from the source and publishes its port on the host's loopback only (`127.0.0.1:4321`): to serve other machines, put an HTTPS reverse proxy in front rather than publishing plain HTTP. A proxy on the host reaches the container from the compose network's gateway, not from `127.0.0.1`: set `MM_TRUSTED_PROXIES=172.31.240.1` (the gateway the compose file fixes) and `MM_ALLOWED_HOSTS` to the public name, under `environment:` (the file shows where). Every process on the host can then claim a forwarded address, so keep the port on the loopback.

The `with-mongo` profile adds a MongoDB 7.0 to try it out with: a one-member replica set, so Watch and Live sync work too. Connect to it as `mongodb://mongo:27017/?replicaSet=rs0`; it is on the compose network only. If you publish its port to reach it from the host, connect with `mongodb://127.0.0.1:<port>/?directConnection=true`, because the set names its member `mongo:27017`, which only the compose network resolves. Two features need more than this MongoDB gives: the `errorAndLog` validation action needs MongoDB 8.1 or later, and Search indexes need a deployment with Atlas Search (`mongot`).

An earlier version of this file ran MongoDB 8. A `mongo-data` volume it wrote holds MongoDB 8 data files, and MongoDB 7.0 does not start on them. To keep what that volume holds, export it first with `mongodump`, using the earlier image. Then remove only that MongoDB and its volume, and restore the export into the new one:

```sh
docker compose -f deploy/docker-compose.yml --profile with-mongo rm -sf mongo
docker volume rm deploy_mongo-data   # the project's name (here "deploy") and "_mongo-data"
```

Do not use `down -v` for this: it also deletes `mm-data`, Mongo Manager's own data (its connections, key and stored backups).

The compose file fixes its network's subnet, so only one such project can run on a host at a time.

It is not MongoDB 8 or later because those versions refuse to start on Linux 6.19 to 7.0.13, and may crash there when they do start ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)). Ubuntu 26.04 and Ubuntu 24.04's newer kernels count as such even when they carry the fix ([SERVER-136848](https://jira.mongodb.org/browse/SERVER-136848)). This applies to any MongoDB 8 you run yourself on such a host too. Mongo Manager itself is not affected.

### Data folder, key and local mode

To bind-mount a host folder instead of the named volume, give it to uid 10001 first and keep it private: `sudo install -d -o 10001 -g 10001 -m 700 /srv/mongo-manager`, then `-v /srv/mongo-manager:/data`.

To supply the key yourself instead of `/data/secret.key`, pass `MM_SECRET_KEY` from a secret store and do not keep it in the compose file.

For personal use without sign-in, publish the port on the host loopback only, and make sure you understand the risk:

```sh
docker run -p 127.0.0.1:4321:4321 -e MM_AUTH=0 -e MM_UNSAFE_NO_AUTH=1 -v mm-data:/data mongo-manager
```

Local mode opens only from a one-time launch link. The container's log (`docker logs`) names the command that prints a link, never the link: `docker exec <container> node /app/dist/cli.cjs open --no-open` prints a link. Each works once, within an hour; the browser then stays in. The link names the port the server listens on inside the container: with the port published elsewhere on the host (`-p 127.0.0.1:8080:4321`), change it to the host's port before opening the link.

## Metrics (optional)

Set `MM_METRICS_TOKEN` (or `metricsToken` in the config file) to a random string of at least 32 characters. `GET /metrics` then answers a scraper that sends `Authorization: Bearer <token>`, in Prometheus text format.

- There is deliberately no command-line option: arguments are visible in the process list.
- The metrics carry no names: no user, connection, database or collection.
- Background jobs appear as `mm_jobs_running{kind="index.create"}` and `mm_jobs_running{kind="collection.duplicate"}`; they replace the pre-release `mm_index_builds_running`, so update alerts that used it.
- Without the token the route does not exist.
- Unlike `/healthz` and `/readyz`, `/metrics` obeys the Host check: the scraper must address the server by a name in `MM_ALLOWED_HOSTS`, or, without that list, by an IP address or `localhost` (a server listening on loopback only takes the loopback names alone). A scraper reaching the container by its service name (`mongo-manager:4321`) gets 403 until that name is listed: `MM_ALLOWED_HOSTS=mongo-manager`.

## Reverse proxy

- `nginx/mongo-manager.conf`: TLS, WebSocket upgrade and forwarded headers. A sub-path variant is shown in comments; use it together with `--base-path`.
- `caddy/Caddyfile`: automatic HTTPS; Caddy passes WebSocket upgrades on its own.
- The app keeps one WebSocket per tab at `<base path>/ws` for background job progress. A proxy that does not pass the upgrade still works: after three failed attempts the page asks the server every 5 seconds while a job runs.

## PM2

`pm2/ecosystem.config.cjs` is a PM2 example. Prefer the system service, which adds OS-level sandboxing.
