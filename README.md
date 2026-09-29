# VPS Manager — deployment & operations

Self-hosted panel for a single VPS: browse and edit everything under your
project roots, and deploy Dockerized projects with one button.

## What it does

- **Projects** — auto-discovers directories under `VPM_ROOTS` (default `/opt`)
  that contain a git repo and/or a compose file. Shows branch, commit, whether
  it is behind `origin`, services, and `.env` key names (never values).
- **Deploy** — one click runs: back up `.env` → `docker compose down` →
  `git fetch --all --prune` → `git reset --hard origin/<branch>` →
  `docker compose up -d --build` → optional health check → automatic rollback
  on failure. Live log stream over SSE.
- **Files** — full editor with syntax highlighting for `.ts`/`.tsx`/`.yaml`/
  `.json`/etc, recursive name + content search, atomic writes with a
  timestamped `.bak` sibling, rename/create/delete.
- **Activity** — append-only audit log of every change and auth event.
- **Settings** — TOTP two-factor enrollment and recovery codes.

## Requirements

- Node.js 22+ (uses the built-in `node:sqlite`; no native compilation)
- Docker with the **compose v2 plugin** (`docker compose version` must work)
- git
- A domain with TLS (Caddy config included in `deploy/`)

## Quick start

```bash
npm install
npm run build

# First run: /dashboard refuses to load until an account exists.
# Open http://localhost:3000 and you get redirected to /setup.
VPM_ROOTS=/opt PORT=3000 npm run start
```

Create the account, then **enable 2FA in Settings before exposing this to the
internet.** The panel can read your `.env` files and restart your containers.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `VPM_ROOTS` | `/opt` | Colon-separated directories the app may touch. Nothing outside these is reachable. |
| `VPM_DATA_DIR` | `./.vpm-data` | SQLite database + WAL location. Mount as a volume. |
| `VPM_DOCKER_SUDO` | unset | Set to `1` to call docker through `sudo` (see below). |
| `VPM_SESSION_TTL_MS` | `43200000` (12h) | Session lifetime (sliding). |
| `VPM_MAX_EDIT_BYTES` | `2097152` (2 MB) | Largest file the editor will open. |
| `VPM_MAX_UPLOAD_BYTES` | `26214400` (25 MB) | Largest upload/download. |

## Production deploy

### Option A — systemd as a non-root user (recommended)

```bash
sudo useradd -r -m -d /opt/vps-manager -s /usr/sbin/nologin vpm
sudo -u vpm -H bash -c 'cd /opt/vps-manager && npm ci --omit=dev && npm run build'
```

Reaching Docker without being root:

```bash
sudo visudo -f /etc/sudoers.d/vps-manager   # file in deploy/
```

Then export `VPM_DOCKER_SUDO=1`. **Note:** `docker compose` is still effectively
root-equivalent, because compose can bind-mount any host path into a container.
This narrows the blast radius from "the app is root" to "the app can restart
your declared stacks", and it keeps a path-traversal bug from becoming a shell.

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
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/vps-manager /opt

[Install]
WantedBy=multi-user.target
```

`ProtectSystem=strict` plus `ReadWritePaths` means a traversal bug cannot touch
anything outside your project tree and the app's own state.

### Option B — container

```bash
docker build -f deploy/Dockerfile -t vps-manager .
docker run -d --name vps-manager \
  -p 127.0.0.1:3000:3000 \
  -v /opt:/opt \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v vpm-data:/data \
  -e VPM_ROOTS=/opt \
  --restart unless-stopped \
  vps-manager
```

The socket mount is the same root-equivalent grant as the docker group. It is
acceptable because the app binds to `127.0.0.1` behind Caddy and requires 2FA —
but it is a trade-off, not a free win.

### TLS

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain
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

**Known limits.**
- `.bak` files from edits accumulate; prune them periodically.
- Rollback restores the previous commit and `.env`, but not a previous *image*
  if the tag was overwritten. Pin tags if you need true image rollback.
- One user account only. Multi-user is not implemented.
- `git reset --hard` discards uncommitted server-side changes. The dashboard
  flags a dirty repo, but that is a warning, not a guard.
- Password change lives in the UI but sends no email — there is no recovery
  path if you forget it. Reset by deleting the row from `users` in the SQLite
  file, then re-run `/setup`.

## Testing

```bash
npm test              # path-confinement tests, no server needed
npm run typecheck
npm run build

# End-to-end against a running server:
npm run start &
node test/e2e.mjs http://localhost:3000
node test/deploy.mjs http://localhost:3000   # runs a REAL docker deploy
```

`test/deploy.mjs` builds an image and starts a container, so it needs a working
Docker daemon and takes a few minutes.
