# VPS Manager — deployment & operations

Self-hosted panel for a single VPS: store and share personal files, browse and
edit project files, and deploy Dockerized projects with one button.

## What it does

- **Projects** — auto-discovers directories under `VPM_ROOTS` (default `/opt`)
  that contain a git repo and/or a compose file. Shows branch, commit, whether
  it is behind `origin`, services, and `.env` key names (never values).
- **Deploy** — one click runs: back up `.env` → `docker compose down` →
  `git fetch --all --prune` → `git reset --hard origin/<branch>` →
  `docker compose up -d --build` → optional health check → automatic rollback
  on failure. The dashboard enables a 60-second health check; live output uses
  SSE with a polling fallback. Recent deployments survive service restarts.
- **Personal files** — a private storage area on your VPS, multiple uploads
  with drag-and-drop, progress and cancellation, and direct downloads of any
  size. Uploads stream to disk and never overwrite existing files.
- **Share links** — expiring download links for personal files, optional
  one-download access, and a management panel to revoke links. Recipients do
  not need a panel account. Project files and known credentials cannot be shared.
- **Project files** — full editor with syntax highlighting for `.ts`/`.tsx`/`.yaml`/
  `.json`/etc, recursive name + content search, atomic writes with a
  timestamped `.bak` sibling, rename/create/delete, streaming upload, and
  download. Stale edits are rejected instead of overwriting newer changes.
- **Activity** — append-only audit log of every change and auth event.
- **Server** — live CPU, memory and storage cards on the Projects page, plus
  a detailed monitoring page with per-core CPU, load, swap, inodes, disk I/O,
  network counters and rates, listening ports, top processes, Docker containers,
  system services, and the panel's own runtime usage and resource limits.
- **Settings** — TOTP enrollment, single-use recovery codes, and password
  changes. Changing security settings revokes other sessions.

## Requirements

- Node.js 22.13+ (uses the built-in `node:sqlite`; no native compilation)
- Docker with the **compose v2 plugin** (`docker compose version` must work)
- git
- A domain with TLS (Caddy config included in `deploy/`)

## Quick start

```bash
npm ci
npm run build

# First run: /dashboard refuses to load until an account exists.
# Open http://localhost:3000 and you get redirected to /setup.
VPM_ROOTS=/opt npm run start -- -H 127.0.0.1
```

Create the account, then **enable 2FA in Settings before exposing this to the
internet.** The panel can read your `.env` files and restart your containers.

For local development, run `npm run dev`. Windows uses a seeded `.dev-root`
sandbox when `VPM_ROOTS` is unset; production never generates demo projects.
Use `.env.example` as a configuration reference. For production, export the
variables or copy it to `.env.local` and adjust the directories.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `VPM_ROOTS` | `/opt` (`.dev-root` on Windows) | Directories the app may touch, separated by `:` on Linux/macOS or `;` on Windows. The file browser provides a selector when multiple roots are configured. |
| `VPM_DATA_DIR` | `./.vpm-data` | SQLite database + WAL location. Mount as a volume. |
| `VPM_FILES_DIR` | `VPM_DATA_DIR/files` | Private personal storage, outside the public webroot. Must be writable by the panel user and included in backups. |
| `VPM_DOCKER_SUDO` | unset | Set to `1` to call docker through `sudo` (see below). |
| `VPM_SESSION_TTL_MS` | `43200000` (12h) | Session lifetime (sliding). |
| `VPM_MAX_EDIT_BYTES` | `2097152` (2 MB) | Largest file the editor will open. |
| `VPM_MAX_UPLOAD_BYTES` | `1073741824` (1 GiB) | Largest streamed upload per file. Downloads have no application size cap. Keep the reverse proxy's body limit aligned. The compatibility multipart endpoint remains limited to 25 MiB. |
| `VPM_HOST_PROC` | `/host/proc` when present | Optional read-only host procfs mount for CPU, memory, uptime, process and network telemetry in a container. Native Linux falls back to `/proc`. |
| `VPM_HOST_SYS` | `/host/sys` when host procfs is available | Read-only sysfs mount for interface state and link speed. |
| `VPM_HOST_OS_RELEASE` | `/host/os-release` | Read-only host `/etc/os-release` file for the VPS distribution name. |
| `VPM_HOST_HOSTNAME` | `/host/hostname` | Read-only host `/etc/hostname` file. |

## Server monitoring

Open **Server** for full system details. The Projects page shows a live summary
and a link to the detailed view. Snapshots refresh every 10 seconds while the
page is visible, share a five-second server-side cache, and deduplicate simultaneous
requests. CPU, memory and traffic charts retain up to 60 actual samples in memory;
history resets when the panel restarts and grows while someone views it. Traffic,
disk and process CPU rates need two samples. Missing counters are shown as unavailable
rather than zero. These are read-only inspections; the page cannot stop processes,
change services, or alter the firewall.

In Windows development the page explicitly shows your **local Windows machine**,
not the remote VPS. Linux installed directly on the VPS uses native procfs and
systemd. The Docker deployment must use the updated `deploy/compose.yaml`, which
mounts `/proc`, `/sys`, `/etc/os-release` and `/etc/hostname` read-only into `/host`.
These mounts identify the VPS host without privileged mode, a host PID namespace
or a systemd/D-Bus control socket. If they are missing, the page marks the data as
the container's visible environment and reports the limitation. The host's systemd
service list is deliberately unavailable inside a container; Docker container
status is available through the already configured Docker socket.

Recreate the manager container after applying the new Compose configuration;
a plain restart does not add mounts. For a sudo-based installation, install the
updated `deploy/vps-manager.sudoers` read-only Docker inspection rules with `visudo`.
Windows uses a fixed PowerShell script for volumes, network counters, services and
process names; request parameters cannot supply commands. Commands have timeouts
and bounded output. Snapshots never include process command lines, environment
variables, Docker configuration, or service credentials, and `/api/server` requires
authentication and returns no-store responses.

Linux memory usage is based on `MemAvailable`, so reclaimable caches are not
mistaken for unavailable RAM. CPU counters exclude guest time already counted in
user time. Metrics use the kernel's documented
[procfs counters](https://www.kernel.org/doc/html/latest/filesystems/proc.html).
Docker usage comes from [Docker's read-only stats](https://docs.docker.com/reference/cli/docker/container/stats/).
Filesystem paths may share a volume and network interfaces may count the same
traffic across virtual hops, so do not add their totals together. Local addresses
and listening ports do not prove public internet reachability or firewall access.

## Personal files and sharing

Open **Files** to start in **Personal files**. Select a folder before uploading;
use **New folder** to organize your files. Choose multiple files or drop them
on the upload area. The download icon works directly for large files, images,
archives and other binary formats. Choose the **Projects** location to use the
existing project browser and editor.

Selecting a supported picture opens an inline preview with fit/actual-size
controls. JPEG, PNG, GIF, WebP, AVIF, BMP and ICO are supported. MP4/M4V, WebM,
MOV and Ogg Theora videos open a native player with playback, seeking, volume
and full screen. Playback depends on the browser's codecs; unsupported files
can still be downloaded. Videos use authenticated byte-range requests instead
of loading the entire file into application memory. Preview responses validate
the media signature, stay private and never permit active HTML/SVG content.
Shared links continue to download files rather than exposing a public player.

Select a personal file, click **Share link**, choose an expiry (1 hour, 24 hours
or 7 days), and click **Create download link**, then **Copy link**. Anyone who
has the URL can download that one file. The default expiry is 24 hours; no link
can last longer than 7 days. Optional one-time links are consumed by the first
accepted GET, even if the recipient cancels. Some messaging services fetch
attachments automatically, so use normal expiring links when that is a concern.
HEAD requests are rejected and do not consume links.

Use **Manage links** to revoke a link, including after its file has been deleted.
Revocation blocks new downloads; an already-running transfer can finish. Editing,
replacing, renaming or deleting a file invalidates its old links. Tokens are shown
only at creation and stored as SHA-256 hashes; existing links cannot be copied
again. Create another link if needed. Treat shared URLs as passwords and use the
public HTTPS address when creating links for someone else. SSH tunnel URLs are
only reachable on your computer.

The default Compose setup stores personal files in
`/var/lib/vps-manager/files` on the host (`/data/files` inside the container).
The folder is created with mode 700 and uploaded files with mode 600. A custom
`VPM_FILES_DIR` must be mounted into the container at the same configured path.
The systemd example already permits writes under `/var/lib/vps-manager`.
Back up personal files along with the SQLite database; they are separate from
your project repositories.

When upgrading, rebuild/restart the panel and apply the updated Caddy site block:
it permits 1 GiB uploads and redacts `/api/shared/*` URLs from access logging using
[Caddy's log filters](https://caddyserver.com/docs/caddyfile/directives/log#filter),
which are supported by the VPS's Caddy 2.6.2. Referring URLs are also removed.
Validate Caddy before reloading. Other reverse proxies, CDNs and monitoring
systems must also omit or redact bearer URLs. The app audits share IDs without
recording tokens. Keep the Next.js port on loopback behind your HTTPS proxy.
The new share table is added automatically without replacing existing users.

## Production deploy

### Option A — systemd as a non-root user (recommended)

```bash
sudo useradd -r -m -d /opt/vps-manager -s /usr/sbin/nologin vpm
sudo -u vpm -H bash -c 'cd /opt/vps-manager && npm ci && npm run build && npm prune --omit=dev'
sudo install -d -o vpm -g vpm -m 700 /var/lib/vps-manager
```

Reaching Docker without being root:

```bash
sudo visudo -f /etc/sudoers.d/vps-manager   # file in deploy/
```

Then export `VPM_DOCKER_SUDO=1`. Give `vpm` read/write access to the intended
project directories and the Git/Docker credentials needed by those projects.
The sudoers grant is root-equivalent: compose files can mount arbitrary host
paths. Only trusted operators should have access to this panel.

```ini
# /etc/systemd/system/vps-manager.service
[Unit]
Description=VPS Manager
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=vpm
WorkingDirectory=/opt/vps-manager
Environment=NODE_ENV=production
Environment=VPM_ROOTS=/opt
Environment=VPM_DATA_DIR=/var/lib/vps-manager
Environment=VPM_DOCKER_SUDO=1
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000 -H 127.0.0.1
Restart=always
RestartSec=5
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/vps-manager /opt

[Install]
WantedBy=multi-user.target
```

`ProtectSystem=strict` limits direct writes to the listed directories.
`NoNewPrivileges=true` must not be set when using sudo; it prevents sudo from
elevating. Docker still has host-level privileges outside the service sandbox.

### Option B — container

```bash
docker build -f deploy/Dockerfile -t vps-manager .
docker run -d --name vps-manager \
  -p 127.0.0.1:3000:3000 \
  -v /opt:/opt \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v vpm-data:/data \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  -e VPM_ROOTS=/opt \
  --restart unless-stopped \
  vps-manager
```

The supplementary group permits the non-root container user to access the
Docker socket. Project files must also be writable by UID 1001 or an added
supplementary group. Mount Git credentials/configuration separately if private
repositories need them. Docker bind mounts referenced by compose must use the
same absolute paths on the host and inside the panel container.

The socket mount grants root-equivalent access. Keep the published port bound
to `127.0.0.1`, use TLS through Caddy, and enroll 2FA before public access.

`deploy/compose.yaml` provides a restart policy, a 512 MB memory limit, and
bounded container logs. Set `VPM_IMAGE` to the built image tag and
`VPM_DOCKER_GID` to `stat -c '%g' /var/run/docker.sock`, then run
`docker compose -f deploy/compose.yaml up -d`. Its default host port is 3090,
bound to loopback. Persistent state is stored in `/var/lib/vps-manager`; create
that directory and its `home` subdirectory with owner UID/GID 1001 and mode 700
before starting. Back up this entire directory when migrating the panel.

For projects owned by another user, grant UID 1001 read/write directory ACLs
and default ACLs for new files. Keep a permission backup before doing so.
Renaming or creating a project at the top level also requires UID 1001 to have
write access to the parent directory (for example `/opt`), even when it already
has write access inside each project. Grant that access only on the intended
project root, using a directory ACL rather than making it world-writable.
Add each trusted Git project to `safe.directory` in
`/var/lib/vps-manager/home/.gitconfig`. Git credentials can be configured in
that private home directory when a project requires them.

Without a domain, access the loopback deployment through SSH:

```bash
ssh -N -L 3090:127.0.0.1:3090 root@YOUR_VPS_IP
```

Keep the tunnel running and open `http://127.0.0.1:3090/setup` to create your
own administrator account. SSH encrypts the traffic. The panel port does not
need to be opened in the VPS firewall.

### TLS

Merge the site block from `deploy/Caddyfile` into `/etc/caddy/Caddyfile`,
preserving any existing sites. It configures `atlas.amirrrreza.ir` and the
container's loopback port 3090. Change the hostname for another deployment;
use upstream port 3000 for the systemd example above. Point the domain's DNS
at the VPS before reloading.

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

`flush_interval -1` matters: without it Caddy buffers the SSE deploy log
stream and you only see output after the deploy finishes.

## Security model

Read this before exposing the panel.

**What a session is worth.** Anyone who authenticates can read every `.env` in
your project roots and restart your containers. Treat a logged-in session as a
root-equivalent credential: long unique password, mandatory TOTP, never share.

**Path confinement.** Every filesystem operation goes through
`src/lib/safe-path.ts`, which:
1. rejects NUL bytes and normalizes the path,
2. `realpath()`s the deepest **existing** ancestor — catching symlinks that
   point outside the root even for files that do not exist yet,
3. requires the result to be inside a root using `path.relative`, so
   `/opt-evil` never passes as `/opt`.

`test/security.test.ts` asserts each of these vectors.

**No shell.** `src/lib/exec.ts` only ever calls `spawn(bin, argsArray)` with
`shell: false`. Nothing in the codebase concatenates user input into a command
string.

**Child environment.** Child processes get a small env, but it deliberately
keeps `HOME`, `DOCKER_CONFIG`, and on Windows `PROGRAMFILES` — the Docker CLI
resolves the `docker compose` **plugin** through those. Stripping them makes
compose fail with a misleading `unknown command`.

**Secrets in the UI.** `.env`, `*.pem`, `id_rsa`, `credentials.json` and
friends render with values masked until you click "Reveal values". This is a
shoulder-surfing guard, not access control — an authenticated session can fetch
the values on demand.

**Audit log.** File writes, deploys, logins (including failures), and
rate-limit events are recorded in SQLite and shown under Activity.

**Transfers and sharing.** Authenticated mutations enforce the session and
same-origin check at the route. The streaming upload route deliberately bypasses
Next's body-buffering Proxy, checks its own authentication/CSRF, and bounds actual
bytes even without Content-Length. Uploads use private temporary files and
exclusive atomic publication; cancelled/failed transfers remove their partial
files. A hard process termination can leave hidden `.vpm-upload-*` files; remove
those only while the panel is stopped. Public download routes accept only a
random 256-bit capability and never a caller-provided filesystem path. Links are
limited to personal storage, revalidate confinement and the file version on every
request, enforce expiry/revocation/download counts in SQLite, and apply rate
limits. Credential-file classification is based on names; do not share a renamed
credential or other sensitive content. Files are served as octet-stream attachments
with `nosniff`, no-store and noindex headers. Only authenticated, signature-checked
raster pictures and videos have inline previews; uploaded HTML/SVG is never
rendered inline. These checks do not scan files for malware or encrypt files at rest.

**Known limits.**
- `.bak` files from edits accumulate; prune them periodically.
- Rollback restores the previous commit and `.env`, but not a previous *image*
  if the tag was overwritten. Pin tags if you need true image rollback.
- One user account only. Multi-user is not implemented.
- `git reset --hard` discards uncommitted server-side changes. The dashboard
  requires confirmation for a dirty repository; API callers must account for
  this behavior themselves.
- There is no password-reset email. If the password is lost, stop the service,
  back up its database, and reset the account locally. Recovery codes replace
  an authenticator code at login; they do not replace a forgotten password.
- Run one application process against one database. A restart marks interrupted
  deployments as failed; inspect the stack before redeploying.

## Testing

```bash
npm test              # confinement, file operations, and deploy orchestration
npm run lint
npm run typecheck
npm run build

# End-to-end against a running server:
npm run test:e2e       # starts a disposable production server after building

# Requires a running Docker daemon and Compose:
npm run test:docker    # real deployments against the local production build
npm run test:container # builds the image; verifies its non-root Linux runtime
```

The unit pipeline tests simulate Docker and use real disposable Git repos.
The transfer tests verify interrupted uploads, binary integrity, duplicate names,
token hashing, expiry, revocation, one-time access, symlink confinement, and stale
links after a file changes. The HTTP tests create temporary roots and an account,
then remove them.
They exercise setup, authentication, MFA/recovery, password changes, file CRUD,
streamed upload/download, public links, concurrent one-time requests, stale-edit
conflicts, and confinement.
The Docker suites create disposable Git repositories and uniquely named
Compose stacks. They verify updates, live SSE output, container inspection,
failed-build and health-check rollback, cooperative abort, and history after
restart, then run the HTTP smoke suite. They remove their own containers,
images, and temporary files on exit. The container suite mounts the Docker
socket and runs with the production image's non-root user.

The CI matrix checks Linux and Windows using the documented
[checkout](https://github.com/actions/checkout) and
[setup-node](https://github.com/actions/setup-node) actions.
An additional Linux job builds and verifies the production container with
real Docker deployments.

CI audits production dependencies with `npm audit --omit=dev`. The full
development audit currently also reports an upstream `braces` pattern-parser
advisory through the Next.js ESLint plugin; npm has no compatible patched
release for that dependency. It is excluded from the production image.

`node test/deploy.mjs <baseUrl>` is an additional real-Docker check for an
explicitly prepared `realapp` fixture: it expects a Git repo one commit behind
origin, a compose file, and a smoke-test account. It resets that repo and starts
containers, so run it only against a disposable environment with a working
Docker daemon.
