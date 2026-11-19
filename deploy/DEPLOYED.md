# VPS deployment — 20 November 2026

Live at <https://atlas.amirrrreza.ir/login> with image
`vps-manager:automation-20261120-v1`, running Next.js 16.4.6 as UID 1001.
The initial automation rollout used this image tag and the source under
`/srv/vps-manager/releases/automation-20261120-v1`. Commit-based updates record
their exact Git revision and image in `/srv/vps-manager/release.json`.

New functionality includes Git repository import, static/image/PostgreSQL/Redis
templates, background Git deployment, stack controls, daily panel-database
snapshots and Docker build-cache maintenance. Generated services bind to loopback;
PostgreSQL and Redis passwords are generated into private project `.env` files.
Existing projects retain their configurations and have no automatic-deployment
rules enabled. Enable updates individually on the Projects page.

The live release passed 29 real-Docker checks and 142 HTTP checks in a disposable
non-root container on the VPS, plus the unit suites. Verification included
background deployment with no browser open, build/health rollback, abort recovery,
stack controls, a serving static website, ready PostgreSQL, authenticated Redis,
and session/history persistence. The local production build, lint, typecheck,
dependency audit and desktop/mobile browser checks passed. Both production and
full dependency audits reported zero vulnerabilities at release time.

Before activation, the live database and deployment configuration were backed up
to `/srv/vps-manager/backups/automation-20261120T014359Z`. The previous
`vps-manager:c27cdbf` image and source release remain available. Activation verified
unchanged persistent mounts and account count, authenticated pages and Docker
access, a successful database snapshot, public HTTPS and unchanged start times
for every unrelated application container. The temporary verification session
was removed. `source` points to the new release and `compose.env` selects its image.

Automatic database snapshots are stored at `/var/lib/vps-manager/backups` on the
host, retain seven copies and are separate from the release backup above. They
cover panel state, not project volumes or personal files. Generated services need
reverse-proxy configuration or an SSH tunnel for external access. Host OS package
and firewall administration remain outside the panel's controls.

## Previous deployment — 9 October 2026

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
