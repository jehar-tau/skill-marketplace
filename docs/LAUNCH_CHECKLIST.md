# What stands between this and real users

Status as of 11 October 2026. "Done" means built and exercised; "Untested live" means built but never run against the real service.

## Product
| Area | State |
| --- | --- |
| Provider side: describe services, dashboard, leads, edit, working area | Done (web) |
| Customer side: post a request, see who responded | Done (web) |
| Chat, share number, agreement, job confirmation, ratings | Done (web) |
| Report, block, account deletion, operations console | Done |
| Marathi, Hindi, English screens | Done; wording not yet reviewed by native speakers |
| Web app served from the server, installable to the home screen | Done |
| Android app | Builds (APK produced); not yet run on a phone |
| iOS app | Same code; not built. Needs an Apple developer account ($99 a year) and a Mac build or Expo cloud build |

## Integrations
| Integration | State | Needed to go live |
| --- | --- | --- |
| Understanding text (Gemini) | Done, tested live | A paid-tier key before real users (free tier may use data for training) |
| Matching vectors (Gemini) | Done, tested live | Tune the relevance floor with real requests |
| Voice (Groq Whisper) | Done, tested with a synthetic Hindi clip | Test with real Marathi speakers |
| Sign-in codes | Pilot code works | Fast2SMS account for real codes (untested live) |
| Browser alerts (web push) | Built; untested live | Try on a real Android phone in Chrome |
| App alerts (Firebase via Expo) | Built; untested live | Firebase project, then an Android build |
| Backup alert by WhatsApp or SMS | Built; untested live | Meta WhatsApp account or SMS provider |
| Photo storage (S3) | Built; untested live | Supabase bucket and keys |
| Hosting | Image builds and runs in staging mode locally | Supabase and Render accounts (SETUP.md Step 7) |

## Before real users (not needed for testing)
- A paid, always-on server and a database with backups. The free ones sleep, pause and keep no backups.
- Your own domain name, for example `app.yourname.in`.
- Fresh API keys; the current ones were shared in a chat.
- A real support email on the legal pages, and a lawyer's read of those pages.
- Play Store listing (developer account, $25 once).
- Error alerts to your phone or email when the server fails. Today errors are only in the server log.
- GitHub branch protection (needs GitHub Pro on a private repository).

## Known limits of the current build
- No in-app calls, payments, chat translation or photo analysis (deferred in the spec).
- A provider is alerted only through the app or browser unless a WhatsApp/SMS backup is configured.
- The operations console uses one shared password.
