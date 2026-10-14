# VPS deployment — 9 October 2026

VPS Manager runs on `5.102.37.139` as the non-root `vpm` container user.
The deployed image is `vps-manager:20261009-files-tree-v3` (Next.js 16.3.8).

Public access: <https://atlas.amirrrreza.ir/login>. Caddy forwards HTTPS to
the panel on VPS loopback port 3090 and automatically renews its TLS certificate.
HTTP redirects to HTTPS. The administrator username and password were randomly
generated and delivered separately; credentials are not stored in this repository.

The account database was backed up under `/srv/vps-manager/backups` before
credentials were changed. Existing sessions were revoked. Enable an
authenticator in Settings if you want two-factor authentication.

The authenticated application layout waits for a request before checking the
SQLite account state. This prevents a build made before account setup from
permanently redirecting authenticated pages to `/setup`.

For emergency access, you can still connect from your computer with:

```bash
ssh -N -L 127.0.0.1:3090:127.0.0.1:3090 root@5.102.37.139
```

Keep that command running, then open <http://127.0.0.1:3090/login>.
The panel account is separate from the VPS SSH account. Use the public HTTPS
address for normal access so production cookies work consistently in browsers.

- Source and deployment configuration: `/srv/vps-manager`
- Compose file: `/srv/vps-manager/source/deploy/compose.yaml`
- Compose environment: `/srv/vps-manager/compose.env`
- Active reverse proxy: `/etc/caddy/Caddyfile` (existing sites preserved)
- Atlas site block: `/srv/vps-manager/atlas.Caddyfile`
- Persistent database and private Git home: `/var/lib/vps-manager`
- Original project permission backup: `/srv/vps-manager/project-permissions.before.acl`
- Restart policy: `unless-stopped`
- Memory limit: 512 MB; bounded container logs

The panel manages `Workspace`, `Demo_Workspace`, `portfolio`, `task-manager`,
and `Demo_TaskManager` under `/opt`. UID 1001 has directory and default ACLs
for these projects, and they are explicitly trusted in the panel's Git config.
No existing application containers were restarted during installation.

The Files browser expands folders in place, loads children on demand, and uses
folder, source, configuration, secret-file, and image icons. Editor libraries load
only after an editable file is selected. New files and uploads
target the selected folder. Rename/delete controls have icons and accessible labels.

UID 1001 has a write ACL on `/opt` so top-level project directories can be renamed.
Its previous ACL is saved at `/srv/vps-manager/opt-permissions.before-files-tree.acl`.
Git trusts both `/opt/Workspace` and `/opt/workspace` for the intended case change.
Filesystem permission errors are reported separately from expired login sessions.
Verification passed for in-place expansion of `Workspace` and nested folders in
the public browser, and authenticated creation, case-only rename, content
preservation, listing, and deletion of a disposable folder directly under `/opt`.
The temporary verification folder and session were removed.

Inspect or restart the panel on the VPS:

```bash
docker logs --tail 100 vps-manager
docker inspect --format '{{.State.Health.Status}}' vps-manager
cd /srv/vps-manager
docker compose --env-file compose.env -f source/deploy/compose.yaml restart manager
```

Back up `/var/lib/vps-manager` and the deployment configuration before an
upgrade. Stop the panel while copying its SQLite database and WAL files, or
use SQLite's backup API. Project repositories require their own backups.

Initial installation verification passed for container health, loopback binding,
SSH-tunnel HTTP access, unauthenticated API rejection, Docker/Compose access,
Git inspection, and temporary file creation/removal in all five project roots.

Public-access verification passed for a trusted HTTPS certificate, HTTP-to-HTTPS
redirect, generated-password login, authenticated dashboard and project access,
Secure/HttpOnly/SameSite cookies, incorrect-password and cross-origin rejection,
setup lock, logout, and container health. The local production HTTP regression
suite also passed all 80 checks, together with lint, typecheck, and production build.
