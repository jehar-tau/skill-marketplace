# Setup guide: making it real, for free

Everything below has a free tier and needs no card unless stated. Do the steps in order; each one ends with a way to check it worked. Free limits change often, so treat the numbers as approximate and check each provider's own page.

All settings go in the file `.env` in this folder. After changing `.env`, restart the server (`pnpm dev:api`).

---

## Step 1 — Smarter understanding and matching (Google Gemini, free)

One Google key covers two jobs: understanding what people say, and comparing meanings across languages for matching.

1. Open https://aistudio.google.com/apikey and sign in with a Google account.
2. Click **Create API key** and copy it.
3. In `.env` set:
   ```
   AI_INTERPRETER=openai_compat
   AI_LLM_API_KEY=<your key>
   AI_EMBEDDER=openai_compat
   AI_EMBED_API_KEY=<your key>
   ```
4. Check the model names. `.env` is pre-filled with `gemini-3.5-flash-lite` and `gemini-embedding-001`. Google renames models often; if the check below fails with "model not found", open https://aistudio.google.com, look at the model list, pick the cheapest "Flash-Lite" model, and put its exact name in `AI_LLM_MODEL`.
5. Run these one at a time:
   ```bash
   pnpm ai:check
   ```
   ```bash
   pnpm db:migrate
   ```
   ```bash
   pnpm db:reembed
   ```

**It worked if** `pnpm ai:check` prints `OK` for both sample sentences and the "same meaning across languages" number is clearly higher than the "unrelated" one.

Things to know:
- The free allowance is reported at roughly 500 requests a day for Flash-Lite and about 1,000 a day for embeddings. That is plenty for a pilot. Google shows your real limits inside AI Studio.
- On the free tier Google may use what is sent to improve its products. Before real users rely on the app, move to the paid tier (Flash-Lite costs a small fraction of a rupee per request).
- If Gemini is down or over its limit, the app falls back to the built-in keyword rules by itself.
- After switching the matching model, the relevance floor in the operations console (Matching tab) starts at 0.45. Tune it once you have real requests.

## Step 2 — Voice input (Groq, free)

1. Open https://console.groq.com/keys, sign up, and create a key.
2. In `.env` set:
   ```
   AI_ASR=openai_compat
   AI_ASR_API_KEY=<your key>
   ```
3. Run:
   ```bash
   pnpm ai:check
   ```

**It worked if** the voice line says the key was accepted. Restart the server and a microphone button appears in the app.

Things to know:
- The free tier is reported at about 2,000 voice clips a day.
- The model is Whisper large v3. It handles Hindi well; Marathi and mixed Marathi-English are weaker. Every clip is shown back as text for the user to confirm, so mistakes are caught, but test it with real speakers. If Marathi accuracy is not good enough, Sarvam AI (https://www.sarvam.ai) is built for Indian languages and gives free starting credits; it would need a small adapter.

## Step 3 — Sign-in for testers, with no SMS cost

There is no free way to send SMS codes in India: operators require sender registration (DLT) and every message costs money. For testing, skip SMS entirely.

In `.env` set:
```
OTP_PROVIDER=pilot
PILOT_CODE=<any six digits you choose>
PILOT_PHONES=9876543210,9123456780
```

Testers enter their own number, then the shared code you give them. `PILOT_PHONES` is the list of numbers allowed in; leave it empty to allow anyone who knows the code.

**Limit of this mode:** anyone who knows the code can sign in as any allowed number. Use it only with people you trust, and switch to real SMS before opening to the public.

**Real SMS later:** 2Factor (https://2factor.in) is already wired in. Sign up, copy the API key, and set `OTP_PROVIDER=twofactor` and `TWOFACTOR_API_KEY=<key>`. Expect roughly ₹0.15–0.25 per code. I could not confirm whether they give free trial credits, and this path has not been run against their live service.

## Step 4 — Try it on an Android emulator on this Mac (optional)

1. Download and install Android Studio: https://developer.android.com/studio (about 1.3 GB; it includes Java and the Android tools).
2. Open it once, accept the defaults in the setup wizard, then open **More Actions → Virtual Device Manager** and press the play button on the default phone.
3. Add these two lines to the file `~/.zshrc`, then open a new terminal:
   ```
   export ANDROID_HOME=$HOME/Library/Android/sdk
   export PATH=$PATH:$ANDROID_HOME/platform-tools
   ```
4. With the server running, in `apps/mobile` run:
   ```bash
   npx expo run:android
   ```
   The first build takes 10–20 minutes.

**It worked if** the app opens in the emulator and you can sign in.

## Step 5 — Install it on a real Android phone

### 5a. Make the server reachable from the phone
```bash
brew install cloudflared
```
```bash
pnpm tunnel
```
It prints an address like `https://something.trycloudflare.com`. Keep that terminal open. No account is needed. The address changes each time you restart the tunnel.

### 5b. Build the app in the cloud (Expo, free)
1. Create an account at https://expo.dev/signup. The free plan allows about 15 Android builds a month, in a slow queue.
2. In `apps/mobile/eas.json`, replace `https://REPLACE-WITH-YOUR-SERVER-ADDRESS` (in the `preview` section) with the tunnel address.
3. In `apps/mobile`, run these one at a time:
   ```bash
   npx eas-cli@latest login
   ```
   ```bash
   npx eas-cli@latest init
   ```
   ```bash
   npx eas-cli@latest build --platform android --profile preview
   ```
4. When it finishes it shows a link and a QR code. Open it on the phone and install the APK (Android will ask you to allow installing from the browser).

**If the tunnel address changes later** you do not need a new build: on the app's sign-in screen, tap the small "Skill Marketplace" line five times, paste the new address, and press "Use this server".

### 5c. Push alerts (Firebase, free)
Without this the app works but providers get no alert when a request arrives.

1. Open https://console.firebase.google.com and create a project (Analytics can be off).
2. Click **Add app → Android**. Package name: `in.skillmarket.app`. Download `google-services.json` and put it in `apps/mobile/`.
3. In Firebase: **Project settings → Service accounts → Generate new private key**. A `.json` file downloads. Keep it private.
4. In `apps/mobile` run:
   ```bash
   npx eas-cli@latest credentials
   ```
   Choose **Android → preview → Google Service Account → Manage your Google Service Account Key for Push Notifications (FCM V1) → Upload** and pick the file from step 3.
5. In `.env` set `PUSH_PROVIDER=expo`, restart the server, and build the app again (step 5b.3).

**It worked if**, with the app closed on the phone, a request from another account makes the phone ring within a few seconds.

## Step 6 — Real sign-in codes and lead alerts by WhatsApp or SMS (small free start)

Nothing here is free for ever: every business message in India costs something. Two routes give you a free start.

### 6a. Sign-in codes: Fast2SMS (₹50 free credit, no sender registration for WhatsApp)
1. Sign up at https://www.fast2sms.com. They advertise ₹50 of free credit after signup.
2. In their dashboard open **Smart OTP**, create an OTP template, and choose **WhatsApp** as the channel (the SMS channel needs sender registration, which they help with for free). Copy the **OTP ID**.
3. Open **Dev API** and copy your **API key**.
4. In `.env` set:
   ```
   OTP_PROVIDER=fast2sms
   FAST2SMS_API_KEY=<api key>
   FAST2SMS_OTP_ID=<otp id>
   ```
5. Restart the server and sign in with a real number. The code should arrive on WhatsApp.

WhatsApp codes cost about ₹0.25 each there, so ₹50 covers roughly 200 sign-ins. Remove `PILOT_PHONES` restrictions only when you are ready for anyone to sign in.

### 6b. Lead alerts on WhatsApp: Meta WhatsApp Cloud API
This sends "you have a new lead" on WhatsApp when the app's push alert was not received.

1. Create a Meta developer account and app at https://developers.facebook.com, and add the **WhatsApp** product. Meta gives you a **test phone number** that can message up to five numbers you verify, free, which is enough to try it.
2. In **WhatsApp → Message templates**, create a **Utility** template named `new_lead` in English, with text such as: "You have a new customer request on Skill Marketplace. Open the app to reply." Wait for approval.
3. Copy the **access token** and the **phone number ID** from the API setup page.
4. In `.env` set:
   ```
   SMS_PROVIDER=whatsapp
   WHATSAPP_TOKEN=<token>
   WHATSAPP_PHONE_NUMBER_ID=<phone number id>
   ```
Once you move off the test number, each alert costs about ₹0.115. Replies to people who message you first are free up to 1,000 a month per number. Going live needs a verified Meta business account and your own phone number.

Neither 6a nor 6b has been run against the live services yet.

---

## Option B — fully open source, nothing to pay, running on this Mac

Use this instead of Steps 1–2 if you want no outside AI service at all. The models run on your own Mac (M3 Pro, 18 GB), so nothing is sent to Google or Groq and there are no daily limits. The trade-offs: replies are slower (a few seconds each), quality on Marathi is lower than Gemini, and it only works while the Mac is on. None of this has been run on this machine yet, because the tools below are not installed.

### B1. Understanding and matching: Ollama
1. Install Ollama from https://ollama.com/download (or `brew install ollama`), and open it once.
2. Download two models, one at a time:
   ```bash
   ollama pull gemma3:12b
   ```
   ```bash
   ollama pull bge-m3
   ```
   `gemma3:12b` (about 8 GB, Google's open model, good with Indian languages) reads what people say. `bge-m3` (about 1.2 GB, MIT licence, multilingual) does the matching. If replies feel slow, try `gemma3:4b`.
3. In `.env` set:
   ```
   AI_INTERPRETER=openai_compat
   AI_LLM_BASE_URL=http://localhost:11434/v1
   AI_LLM_MODEL=gemma3:12b
   AI_LLM_API_KEY=
   AI_LLM_TIMEOUT_MS=60000
   AI_EMBEDDER=openai_compat
   AI_EMBED_BASE_URL=http://localhost:11434/v1
   AI_EMBED_MODEL=bge-m3
   AI_EMBED_API_KEY=
   AI_EMBED_DIMS=1024
   ```
4. Run, one at a time:
   ```bash
   pnpm ai:check
   ```
   ```bash
   pnpm db:migrate
   ```
   ```bash
   pnpm db:reembed
   ```

### B2. Voice: whisper.cpp
1. Install:
   ```bash
   brew install whisper-cpp ffmpeg
   ```
2. Download a model file (about 1.6 GB) from https://huggingface.co/ggerganov/whisper.cpp/tree/main — pick `ggml-large-v3-turbo.bin`.
3. Start the speech server (leave the terminal open):
   ```bash
   whisper-server -m ~/Downloads/ggml-large-v3-turbo.bin --port 8178 --inference-path /v1/audio/transcriptions --convert -l auto
   ```
   If it rejects an option, run `whisper-server --help`; option names have changed between versions.
4. In `.env` set:
   ```
   AI_ASR=openai_compat
   AI_ASR_BASE_URL=http://localhost:8178/v1
   AI_ASR_MODEL=whisper-1
   AI_ASR_API_KEY=
   ```
For better Marathi, AI4Bharat's IndicConformer (MIT licence, https://github.com/AI4Bharat/IndicConformerASR) is built for Indian languages, but it needs a small wrapper server that does not exist here yet.

### B3. Real SMS codes from your own phone, with no SMS company
An old Android phone with a SIM that has an SMS pack can send the codes itself.

1. On that phone install **SMS Gateway for Android** (open source, Apache 2.0): https://sms-gate.app
2. In the app turn on **Local Server**. It shows an address, a username and a password. The phone and this Mac must be on the same Wi-Fi.
3. In `.env` set:
   ```
   OTP_PROVIDER=sms
   SMS_PROVIDER=phone
   SMS_PHONE_URL=http://<address shown in the app>:8080
   SMS_PHONE_USER=<username>
   SMS_PHONE_PASS=<password>
   ```
Limits you should know: Indian SIMs are capped at roughly 100 SMS a day, operators may block a personal SIM that sends automated messages, and their terms do not allow commercial use. It is fine for a pilot of a few dozen people and not for launch.

### What stays the same
- **Push alerts** still go through Firebase (Step 5c). Android offers no reliable open-source replacement, and Firebase messaging is free at any volume.
- **The database, queue, cache, the app and the server** are already open source: PostgreSQL, PostGIS, pgvector, Redis, pg-boss, React Native, Expo, Fastify.
- **Building the Android app** can be done on this Mac with Android Studio (Step 4) and no Expo account: `npx expo run:android --variant release` produces an installable APK.

### Which should you pick?
| | Free cloud tier (Steps 1–2) | Open source on this Mac (Option B) |
| --- | --- | --- |
| Cost | Free within daily limits | Free, no limits |
| Marathi quality | Better | Lower; test before relying on it |
| Speed | About 1 second | A few seconds per request |
| Privacy | Text goes to Google and Groq | Nothing leaves the Mac |
| Works when Mac is off | AI yes, server no | No |
| When you grow | Pay per use | Needs a rented GPU server, which costs more than the cloud tier at small volume |

My recommendation: start with the free cloud tier for quality, and keep Option B as the fallback if limits or privacy become a problem. You can switch between them by editing `.env`; no code changes.

---

## What is still not free or not done

| Item | Situation |
| --- | --- |
| SMS codes for the public | Paid per message, and needs sender registration. Pilot mode covers testing. |
| SMS fallback alerts | Stay switched off (logged only) until an SMS provider is set. Push covers testing. |
| A permanent server | The tunnel only works while this Mac is on and awake. A hosted server is the next step once testing goes well. |
| iPhone | Not set up. The code supports it; it needs an Apple developer account ($99 a year). |
| Photo storage | On this Mac's disk. Fine for testing. |
