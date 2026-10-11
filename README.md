# Skill Marketplace

Two views — **Find Help** and **Offer Help** — where people say what they need or what they can do, in Marathi, Hindi or English, and nearby matches are told. Built to [Skill_Marketplace_Spec_v0.5.md](Skill_Marketplace_Spec_v0.5.md).

## What is here

| Path | What it is |
| --- | --- |
| `apps/mobile` | The app: React Native + Expo. Android is the target; the same code runs in a browser. |
| `apps/api` | HTTP API, realtime gateway, and the operations console at `/admin`. |
| `apps/worker` | Background worker for production (in development the API runs it in-process). |
| `packages/core` | Everything the backend does: sign-in, language understanding, matching, notifications, chat, trust, safety, admin. |
| `packages/contracts` | Shared request shapes, the hidden category list, and attribute rules. |
| `packages/core/migrations` | Database schema. |

## Run it locally

Needs Docker and Node 24 with pnpm.

```bash
pnpm install
```
```bash
pnpm infra:up
```
```bash
pnpm db:migrate
```
```bash
pnpm db:seed
```
```bash
pnpm dev:api
```
In a second terminal:
```bash
pnpm dev:mobile
```
Then press `w` for the browser, or `a` for an Android emulator.

- App in the browser: http://localhost:8081 when you start it yourself with `pnpm dev:mobile`. When Claude is running the preview for you, it is at http://localhost:8090 instead.
- Operations console: http://localhost:4000/admin (token is `ADMIN_TOKEN` in `.env`)
- Sign in with any 10-digit number. In development the code is shown on screen.
- `pnpm db:seed` adds eight demo providers around Pune (phones 9800000001–9800000008) so a request has someone to reach.

Tests (run against a separate test database):
```bash
pnpm test
```

**To connect free AI, voice, push alerts and install it on a phone, follow [SETUP.md](SETUP.md).**

## What works without any outside account

Everything runs with built-in stand-ins, chosen in `.env`:

| Part | Development stand-in | To make it real |
| --- | --- | --- |
| Sign-in code | Shown on screen | `OTP_PROVIDER=pilot` (shared test code, no SMS) or `twofactor` (real SMS) |
| SMS fallback | Printed in the API log | `SMS_PROVIDER=http` |
| Push alerts | Printed in the API log | `PUSH_PROVIDER=expo` and an EAS build with Firebase credentials |
| Understanding text | Built-in keyword rules | `AI_INTERPRETER=openai_compat` + a free Gemini key (or `anthropic`) |
| Matching vectors | Built-in hashed vectors | `AI_EMBEDDER=openai_compat` + an embedding endpoint, then re-run `pnpm db:migrate` |
| Voice input | Off (mic button hidden) | `AI_ASR=openai_compat` + a speech-to-text endpoint |
| Photos | Stored on local disk | `MEDIA_STORAGE=s3` |

## Useful commands

| Command | What it does |
| --- | --- |
| `pnpm test` | Backend tests against a separate test database |
| `pnpm ai:check` | One real call to each AI service set in `.env`, with a plain pass/fail |
| `pnpm eval` | Runs the labelled sentences in `packages/core/eval/cases.json` and reports accuracy (`pnpm eval rules` forces the built-in rules) |
| `pnpm db:reembed` | Rebuilds matching vectors after changing the embedding model |
| `pnpm tunnel` | Gives the server a temporary public https address for phone testing |

## Public pages

Served by the API, needed for the Play Store listing: `/legal/privacy`, `/legal/terms`, `/legal/delete-account`. They are plain-language templates describing what the app does and have not been reviewed by a lawyer. Set `SUPPORT_EMAIL` in `.env` to a real inbox first.

## Deploying the server

`Dockerfile` builds one image for both the API and the worker. Any host that runs containers and offers PostgreSQL (with PostGIS and pgvector) and Redis will do. Run `pnpm db:migrate` once per release, then start the API and the worker as two processes with `INLINE_WORKER=false`. The image has not been built or deployed anywhere yet.

## Building the Android app

This machine has no Java or Android SDK, so no APK has been built yet. Two routes:

- **Cloud build (no local setup):** `npx eas-cli@latest build --platform android --profile preview` from `apps/mobile`. Needs a free Expo account.
- **Local build:** install Android Studio, then `npx expo run:android` from `apps/mobile`.

Set `EXPO_PUBLIC_API_URL` to the server address the phone can reach.

## Where the build differs from the spec

- **Attribute constraints** (diet, order size, notice period) are applied in code after the SQL filters rather than inside SQL. The candidate set is small, and the rules stay in one shared file.
- **Text relevance** is a token-overlap score computed in code. The full-text index exists in the schema but is not yet used for ranking.
- **Udyam badge:** the number is format-checked and stored encrypted; the badge appears only after an operator approves it in the console. There is no automatic government lookup.
- **Admin sign-in** is one shared token, suitable for a few operators.
- **Observability** is structured logs plus the metrics page in the console. OpenTelemetry tracing is not wired in.
- **Backups, alerts and hosting** are deployment tasks and are not set up.
