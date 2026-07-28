# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/cofedish/cofemine-panel/security/advisories/new)
on this repository. If that is unavailable to you, open a regular issue containing only the words
"security report — please contact me" and no technical detail, and a maintainer will arrange a private
channel.

A useful report contains: what you can do that you should not be able to, the smallest set of steps
that reproduces it, and which role or network position the attacker needs. A working proof of concept
is welcome but never required — a precise description of the flaw is worth more than an exploit.

This is a small self-hosted project maintained in spare time. There is no bounty, and no guaranteed
response time; expect a first reply within a week or so.

## What is in scope

Anything that crosses a boundary the panel claims to enforce:

- Authentication or session handling (login, password reset, first-run setup).
- Authorization — reaching a server, backup, schedule or setting that your role should not reach.
- The node agent's HTTP surface, the Docker socket, and anything that leads to code execution on the
  host.
- Secret exposure — integration keys, agent tokens, RCON passwords, the maven-cache CA private key.
- The unauthenticated surface: `/p/*` public pack links and the public `/mirror/*` endpoints.
- Cross-site scripting or request forgery in the panel UI, including content rendered from Modrinth
  and CurseForge.

## What is out of scope

These are documented properties of the design rather than defects. They are explained in
[docs/security.md](docs/security.md).

- **The agent has root-equivalent access to the host.** It mounts `docker.sock` by necessity; anything
  able to drive that socket can start a privileged container. Reducing this requires rootless Docker or
  splitting the socket out of the agent, both of which are tracked work, not undisclosed bugs.
- **A Minecraft server runs untrusted code by design.** Mod jars are unsandboxed and are downloaded
  from registries that do not moderate code. Whoever can write into a server's data directory can
  affect that server; the panel bounds the blast radius, it does not eliminate it.
- **Owners and admins are fully privileged.** They can execute console commands, edit files and create
  servers; that is the product.
- Findings that require an already-compromised host, a modified panel deployment, or physical access.
- Missing hardening headers or dependency advisories with no demonstrated path to impact in this
  codebase — these are welcome as ordinary issues rather than security reports.

## Supported versions

The project is pre-1.0 and single-branch. Only the current `main` receives fixes; there are no
backports. Deployments track `main` through the published container images.

## Operating this panel safely

If you run Cofemine Panel, these are the operator-side items that no amount of application code can
cover:

1. **Do not expose the agent or Postgres.** Only the web service should be reachable; put it behind a
   reverse proxy that terminates TLS.
2. **Generate real secrets.** `SECRETS_KEY`, `JWT_SECRET` and `AGENT_TOKEN` must be random per
   deployment. The API refuses to start on the shipped placeholder values.
3. **Set the site-specific CIDRs.** `MCNET_CIDR` and `TRUSTED_PROXY_CIDR` ship empty, and while they
   are empty the protections they control are inactive — see the notes in `.env.example`.
4. **Rotate the maven-cache CA** after upgrading past the volume split, and keep backups off the host.
5. **Treat modpacks as third-party code.** Prefer packs you have reason to trust, and remember that
   enabling a public pack link publishes what it points at.

The current known-unfixed items are listed at the end of [docs/security.md](docs/security.md).
