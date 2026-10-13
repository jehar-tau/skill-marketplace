// Public pages the app stores require: privacy policy, terms, and a way to ask
// for account deletion from outside the app. The wording is a plain-language
// template that describes what this software actually does. It has not been
// reviewed by a lawyer; have it reviewed before a public launch.

import type { FastifyInstance } from 'fastify';
import { config } from '@sm/core';

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — ${config.APP_NAME}</title>
<style>
  body { font: 17px/1.6 system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; color: #1c1b19; background: #f6f5f2; }
  @media (prefers-color-scheme: dark) { body { color: #eeece7; background: #161513; } a { color: #5cc4a8; } }
  h1 { font-size: 26px; } h2 { font-size: 19px; margin-top: 28px; } li { margin: 6px 0; } .mute { opacity: .7; font-size: 15px; }
</style></head><body>
<h1>${title}</h1><p class="mute">${config.APP_NAME} · Version ${config.termsVersion}</p>
${body}
<p class="mute"><a href="/legal/privacy">Privacy</a> · <a href="/legal/terms">Terms</a> · <a href="/legal/delete-account">Delete account</a></p>
</body></html>`;

const contact = () => `<a href="mailto:${config.SUPPORT_EMAIL}">${config.SUPPORT_EMAIL}</a>`;

const privacy = () => page('Privacy policy', `
<p>This app introduces people who need a job done to people nearby who can do it. This page says what we keep about you and why.</p>
<h2>What we collect</h2>
<ul>
  <li><b>Your phone number</b>, to sign you in. It is stored encrypted. Nobody else on the app sees it unless you press "Share my number" in a chat.</li>
  <li><b>What you tell us you need or offer</b>, in your own words, and the facts we read from it (for example the kind of work, a quantity or a time).</li>
  <li><b>Your area.</b> We use your location to find people near you. Other people see only a rough distance, never your address or exact position.</li>
  <li><b>Your chats, photos you send in chat, agreements and ratings.</b></li>
  <li><b>A device token</b>, so we can send you alerts.</li>
</ul>
<h2>Voice</h2>
<p>If you speak instead of typing, the recording is turned into text and then deleted. We keep the text, not the audio.</p>
<h2>How AI is used</h2>
<p>An AI model reads what you say you are good at, the photos you add as examples of your work, and your chats about jobs, in order to build <b>your own</b> work profile: for example what you make, prices you quoted, and how you like to work.</p>
<ul>
  <li>What it writes is shown only to you, and you can delete any line.</li>
  <li>Phone numbers, links and payment handles are removed before a chat is sent to the model.</li>
  <li>You can switch this off in Settings. A chat is only read when both people in it have it switched on.</li>
  <li>Voice notes are not read for this.</li>
</ul>
<h2>Who else handles your data</h2>
<p>To understand what you say and to send alerts we may use outside services: a speech-to-text service, a language model, and a push-notification service. They receive only what is needed for that job. We do not sell your data, and we do not train AI models on your chats or photos.</p>
<h2>What other people see</h2>
<ul>
  <li>If you offer several services, a customer sees only the one that matched their request.</li>
  <li>The other person in a chat sees your name, your messages, and a short reputation line (jobs done and rating).</li>
</ul>
<h2>Deleting your data</h2>
<p>You can delete your account in the app under Settings. This removes your phone number and name, removes your services, and blanks your messages. See <a href="/legal/delete-account">Delete account</a>.</p>
<h2>Contact</h2>
<p>Questions or complaints: ${contact()}.</p>`);

const terms = () => page('Terms of use', `
<p>By using this app you agree to the following.</p>
<ul>
  <li><b>We only introduce people.</b> Any work, price and payment is agreed directly between the two of you. We are not a party to the job, we do not hold or move money, and we do not guarantee the work or the payment.</li>
  <li><b>You must be an adult</b> (18 or older) to have an account.</li>
  <li><b>Be truthful</b> about what you offer and what you need. Do not claim licences or qualifications you do not have. You are responsible for following the laws and licence rules that apply to your work.</li>
  <li><b>Stay safe.</b> Never pay in advance or share a one-time code with someone you have not met. Use Report and Block if someone behaves badly.</li>
  <li><b>No abuse.</b> Harassment, fraud, spam and illegal services are not allowed. We may suspend or remove accounts that break these rules.</li>
  <li><b>Ratings</b> must reflect a real job. Fake or exchanged ratings may be removed.</li>
  <li><b>The service may change or be unavailable</b> at times. We may update these terms; the version date is shown above.</li>
</ul>
<p>Contact: ${contact()}.</p>`);

const deletion = () => page('Delete your account', `
<h2>In the app</h2>
<ol>
  <li>Open the app and tap the settings button (⚙︎) at the top right.</li>
  <li>Scroll to the bottom and tap <b>Delete my account</b>, then confirm.</li>
</ol>
<p>This happens immediately.</p>
<h2>If you cannot open the app</h2>
<p>Email ${contact()} from any address and include the phone number you signed up with. We will confirm by a message to that number and delete the account within 7 days.</p>
<h2>What is deleted and what stays</h2>
<ul>
  <li><b>Deleted:</b> your phone number, your name, your services, what you said to create them, your business registration number if you added one, and the content of the messages and photos you sent.</li>
  <li><b>Kept without your identity:</b> the fact that a conversation, agreement or rating existed, so the other person's history stays correct.</li>
  <li><b>Kept for up to 90 days:</b> reports about safety, so that deleting an account cannot be used to escape a complaint.</li>
</ul>`);

export function registerLegalRoutes(app: FastifyInstance) {
  app.get('/legal/privacy', async (_req, reply) => reply.type('text/html').send(privacy()));
  app.get('/legal/terms', async (_req, reply) => reply.type('text/html').send(terms()));
  app.get('/legal/delete-account', async (_req, reply) => reply.type('text/html').send(deletion()));
}
