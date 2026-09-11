# Deploying Tally-Talk as a Windows Service

Covers first-time install on a Windows machine (AWS Windows Server or a
client machine) and every deployment/update after that. Two scripts:

- `install-service.ps1` — run **once** per machine.
- `update-service.ps1` — run for **every** deployment after that.

Neither script touches business logic, Tally, or GST/rate/godown/posting
behavior. They only manage the Windows Service wrapper around the existing
`node src/server.js` entry point.

## Prerequisites

1. **Node.js >= 22.13.0** installed and on `PATH` (`node --version`). This
   project uses Node's built-in `node:sqlite`, which needs this minimum to
   run without the `--experimental-sqlite` flag — verified against the
   official Node.js docs, not assumed.
2. **NSSM** (https://nssm.cc/) downloaded and `nssm.exe` on `PATH`, or pass
   `-NssmPath` to either script.
3. **Git** on `PATH` (used by `update-service.ps1` to fetch releases).
4. TallyPrime running on this machine with its HTTP interface enabled on
   the configured port (default `9000`), reachable at `127.0.0.1` — same as
   local development. Tally does not strictly need to be running before the
   first `install-service.ps1` run, but it does need to be running (or have
   run at least once already) for a clean first application startup — see
   "First boot and Tally availability" below.
5. The repository already cloned to its final location on this machine
   (e.g. `D:\Tally-Talk`), with `.env` created from `.env.example` and
   filled in with real values (bot token, webhook secret, allowed user
   IDs, Tally host/port, etc.).

## First-time install

```powershell
# From an elevated PowerShell prompt, in the repo root:
npm ci --omit=dev
.\deploy\install-service.ps1
```

This registers a Windows Service named `TallyTalk` (override with
`-ServiceName`) that:
- Runs `node --env-file=.env src\server.js`, with the repo root as its
  working directory.
- Starts automatically on boot (`Start=SERVICE_AUTO_START`).
- Restarts automatically on a crash, with a 5-second delay between
  restarts (so a crash loop backs off instead of hammering the process).
- Writes stdout/stderr to `logs\tallytalk.out.log` /
  `logs\tallytalk.err.log`, rotated once a file exceeds ~10MB.

The script refuses to run if `.env` or `src\server.js` are missing under
`-InstallDir`, and is safe to re-run (it removes and reinstalls the
service first) if you need to change its configuration.

## Deploying an update

```powershell
.\deploy\update-service.ps1 -Ref v0.3.0     # a tagged release (recommended)
.\deploy\update-service.ps1 -Ref main       # latest main
```

This stops the service, fetches and checks out the requested ref, runs
`npm ci --omit=dev` **only if** `package.json`/`package-lock.json` changed
in that update, restarts the service, and polls `GET /health` until it
returns `200` (or fails loudly after ~20 seconds if it never does).

**`.env` and `data\` (the SQLite database and its `-wal`/`-shm` sidecar
files) are never touched.** Both are already `.gitignore`d, so a
`git checkout`/`git pull` cannot overwrite or delete them — the script
additionally verifies both are still present, byte-identical for `.env`,
before declaring the deploy safe to proceed past that point.

If the smoke check fails, the script exits non-zero with a pointer to
`logs\tallytalk.err.log` — it does **not** attempt an automatic rollback.

## First boot and Tally availability

On a genuinely first-ever startup (empty database, Tally never
successfully synced even once), the application fails closed if Tally is
unreachable — this is existing, intentional behavior (`startupSync.js`),
not something this deployment tooling changes. Make sure TallyPrime is
running before the very first `install-service.ps1`/service start on a
new machine. On every later restart, once at least one sync has ever
succeeded, the app starts fine even if Tally is temporarily down, and
self-heals the moment a real request needs fresh data.

## Local testing checklist (before AWS)

You can validate the service wrapper itself on any Windows machine before
touching AWS:

- [ ] `install-service.ps1` completes without error.
- [ ] `nssm status TallyTalk` reports `SERVICE_RUNNING`.
- [ ] `logs\tallytalk.out.log` shows the same startup sequence as
      `npm run dev` (config/db, Tally sync, "TallyTalk listening", webhook
      registration if `PUBLIC_WEBHOOK_URL` is set).
- [ ] `GET http://127.0.0.1:<PORT>/health` returns `200`.
- [ ] `nssm restart TallyTalk` — service comes back up, `/health` recovers.
- [ ] Kill the Node process directly (Task Manager) — NSSM restarts it
      automatically within a few seconds.
- [ ] Reboot the machine — service is running again afterward without any
      manual step.
- [ ] `update-service.ps1 -Ref <a branch/tag with no real changes>` —
      completes, service stays healthy, `.env`/`data\` untouched (compare
      file hashes/timestamps before and after).

## What this deliberately does NOT do yet

Per the current phase of this project: no MSI/installer, no Docker, no
PM2, no custom file logger inside the app (NSSM's log redirection is
enough for now), no Credential Manager/DPAPI integration, no automated
rollback, no automatic Tally installation/startup. These may be worth
adding later; none of them are required for the current AWS/client testing
goal.
