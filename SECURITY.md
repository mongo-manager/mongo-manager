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

## Scope

In scope: the server, the web app, the command-line tool, the Docker image, the first-party plugins and
the plugin sandbox. Third-party plugins are their authors' responsibility; a way for a plugin to escape
the sandbox or act beyond its approved permissions is in scope.

How Mongo Manager protects data (encryption at rest, sessions, the plugin sandbox, masking) is described
in the README and on the Security page of the in-app documentation.
