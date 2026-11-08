# Security policy

## Supported versions

| Version | Supported                     |
| ------- | ----------------------------- |
| 1.x     | Yes: fixes ship as 1.x.y      |

## Reporting a vulnerability

Please report it privately, never in a public issue, pull request or discussion:

- open a private report on GitHub: <https://github.com/mongo-manager/mongo-manager/security/advisories/new>
  (the repository's **Security** tab → **Report a vulnerability**).

Include what you can of:

- the version (`mongo-manager --version`) and how it runs (npm, standalone, Docker, service);
- the mode (local or team) and the role of the user involved;
- the steps that show the problem, and what an attacker gains;
- whether it is already known publicly.

You will get an answer within 7 days. A confirmed issue is fixed in a patch release, credited to you in
the release notes unless you prefer otherwise, and disclosed once the fix is out.

## Release signing

Each release's `SHA256SUMS` is signed with Mongo Manager's Ed25519 release key: the signature is the
release's `SHA256SUMS.sig` (base64), and the public key is `RELEASE_PUBLIC_KEYS` in
`packages/shared/src/updates/source.ts`. The app installs an update only when that signature verifies
and every downloaded file matches `SHA256SUMS`, and it checks every file of the version it runs again
at each start. To check a download by hand (OpenSSL 3):

```sh
printf '%s' '<public key>' | base64 -d | openssl pkey -pubin -inform DER -out release-key.pem
base64 -d SHA256SUMS.sig > SHA256SUMS.sig.bin
openssl pkeyutl -verify -pubin -inkey release-key.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig.bin
sha256sum --check --ignore-missing SHA256SUMS
```

A release offered without a signature that verifies is a security issue: report it as above.

What the checks protect against is a changed download or a changed file. Whoever can write the data
directory is the service's own account and is trusted as it is: it could also point the app back at an
older signed version. On Windows, where LocalService is shared with other services, a program that
account started outside this install is not ended before an updated version starts.

## Scope

In scope: the server, the web app, the command-line tool, the Docker image, the first-party plugins,
the plugin sandbox and the updater (its signature check, download and rollback). Third-party plugins
are their authors' responsibility; a way for a plugin to escape the sandbox or act beyond its approved
permissions is in scope.

How Mongo Manager protects data (encryption at rest, sessions, the plugin sandbox, masking) is described
in the README and on the Security page of the in-app documentation.
