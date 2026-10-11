# Environments and how changes reach users

There are three environments. Each has its own database, its own secrets and its own copy of the app, so nothing done in one can damage another.

| Environment | Purpose | Git branch | Server | App on the phone |
| --- | --- | --- | --- | --- |
| **Development** | Building and trying things | `dev` and feature branches | Your own Mac | "Skill Marketplace (Dev)" |
| **Staging** | A full rehearsal with testers before release | `staging` | Hosted, small | "Skill Marketplace (Staging)" |
| **Production** | Real users | `main` | Hosted | "Skill Marketplace" |

The three apps have different package names, so all three can be installed on one phone.

## How a change moves

```
feature branch ──pull request──▶ dev ──pull request──▶ staging ──pull request──▶ main
                   (checks run)        (checks run,            (checks run,
                                        staging image built)    production image built)
```

1. Start from `dev`: `git checkout dev && git pull && git checkout -b my-change`.
2. Push the branch and open a pull request into `dev`. The checks (type-check, tests, language accuracy) must pass.
3. When `dev` is in a good state, open a pull request from `dev` into `staging`. Merging it builds the staging server image.
4. Test on staging with the staging app.
5. Open a pull request from `staging` into `main`. Merging it builds the production image.

Never commit directly to `staging` or `main`. Fixes go in through `dev` so the three never drift apart.

## What each hosted environment needs

Staging and production each need their own set of these. Staging can use the smallest size of everything.

| Service | What it is for | Requirement |
| --- | --- | --- |
| **PostgreSQL** | All data | Version 16 or newer, with the **PostGIS** and **pgvector** extensions |
| **Redis** | Rate limits, who is online, fan-out of live updates | Any managed Redis |
| **Container host, 2 processes** | The API and the background worker | Must allow long-lived WebSocket connections; region in or near India |
| **File storage** | Chat photos | Any S3-compatible bucket |
| **A web address with https** | What the app connects to | e.g. `api-staging.yourdomain.in`, `api.yourdomain.in` |

Already account-based and shared across environments by using separate keys or projects: Gemini (understanding and matching), Groq (voice), Firebase (push alerts), Fast2SMS or another provider (sign-in codes), Expo (app builds).

## Settings per environment

Every setting is listed in `.env.example`. The ones that must differ per environment:

| Setting | Development | Staging | Production |
| --- | --- | --- | --- |
| `APP_ENV` | `development` | `staging` | `production` |
| `NODE_ENV` | `development` | `production` | `production` |
| `DATABASE_OWNER_URL`, `DATABASE_APP_URL`, `REDIS_URL` | local Docker | staging services | production services |
| `PUBLIC_BASE_URL` | Mac's address | staging https address | production https address |
| `JWT_SECRET`, `PHONE_ENC_KEY`, `PHONE_HASH_KEY`, `MEDIA_SIGNING_KEY`, `ADMIN_TOKEN` | generated locally | **unique, generated** | **unique, generated** |
| `OTP_PROVIDER` | `dev` or `pilot` | `pilot` | `fast2sms` (or another real provider) |
| `PUSH_PROVIDER` | `dev` | `expo` | `expo` |
| `MEDIA_STORAGE` | `local` | `s3` | `s3` |
| `INLINE_WORKER` | on (one process) | `false` (separate worker) | `false` |

Generate each secret with `openssl rand -hex 32`. **Never reuse a secret between environments, and never change `PHONE_ENC_KEY` or `PHONE_HASH_KEY` once an environment has users**: stored phone numbers could no longer be read.

The server refuses to start with `NODE_ENV=production` if sign-in is in `dev` mode or the default secret is still in place.

## Where secrets live

- **On your Mac:** the `.env` file. It is never committed.
- **Staging and production:** in the hosting provider's secret settings for that environment.
- **GitHub:** the `staging` and `production` *Environments* in the repository settings hold anything the deploy step needs (for example the host's deploy token). Production can be set to require your approval before a deploy runs.

## Releasing

Per release, for each environment:
1. Run `pnpm db:migrate` against that environment's database.
2. Start the new image as two processes: the API (`pnpm --filter @sm/api start`) and the worker (`pnpm --filter @sm/worker start`).
3. Check `https://<address>/health` returns `{"ok":true,"env":"staging"}` (or `production`).

The image is built automatically on a merge to `staging` or `main` and stored at `ghcr.io/<owner>/skill-marketplace` with the tag `staging` or `production`. Starting it on a host is manual until a host is chosen; once it is, the deploy becomes one more step in `.github/workflows/release-image.yml`.

## App builds

From `apps/mobile`:

| Build | Command |
| --- | --- |
| Development APK, on this Mac | `pnpm build:apk` (from the repo root) |
| Staging APK, in Expo's cloud | `npx eas-cli@latest build --platform android --profile staging` |
| Production, for the Play Store | `npx eas-cli@latest build --platform android --profile production` |

Put each environment's server address in `apps/mobile/eas.json` first.
