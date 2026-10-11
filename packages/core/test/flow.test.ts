import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { asActor, asSystem, closePools } from '../src/db';
import * as conversations from '../src/modules/conversations';
import * as identity from '../src/modules/identity';
import * as intake from '../src/modules/intake';
import * as matching from '../src/modules/matching';
import * as notifications from '../src/modules/notifications';
import { devOutbox } from '../src/modules/providers';
import * as safety from '../src/modules/safety';
import * as trust from '../src/modules/trust';
import { redis } from '../src/redis';
import { ask, matchesFor, MUMBAI, newUser, offer } from './helpers';

afterAll(async () => {
  await closePools();
  redis.disconnect();
});

const expectCode = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toMatchObject({ code });
};

describe('matching and dispatch', () => {
  it('notifies a provider once per request even when two of their skills fit', async () => {
    const cook = await newUser('Cook');
    await offer(cook, 'I make homemade chicken biryani, orders from 1 to 5 kg');
    await offer(cook, 'I also cook mutton biryani and pulao for parties');
    const asker = await newUser('Asker');
    const requestId = await ask(asker, 'I need 2 kg chicken biryani tomorrow at 8 pm');
    await matching.dispatchRequest(requestId);
    const rows = (await matchesFor(requestId)).filter((m) => m.provider_account_id === cook.accountId);
    expect(rows).toHaveLength(1);
    // Running dispatch again must not create a second wave or a second notification.
    await matching.dispatchRequest(requestId);
    expect((await matchesFor(requestId)).filter((m) => m.provider_account_id === cook.accountId)).toHaveLength(1);
  });

  it('never sends a vegetarian request to a non-veg capability, or out of the service area', async () => {
    const nonveg = await newUser('NonVeg');
    await offer(nonveg, 'I make chicken biryani and mutton curry');
    const veg = await newUser('Veg');
    await offer(veg, 'I make pure veg biryani and paneer sabzi');
    const far = await newUser('Far');
    await offer(far, 'I make veg biryani and veg pulao', MUMBAI);
    const asker = await newUser('VegAsker');
    const requestId = await ask(asker, 'Need 1 kg veg biryani tomorrow 7 pm');
    await matching.dispatchRequest(requestId);
    const providers = (await matchesFor(requestId)).map((m) => m.provider_account_id);
    expect(providers).toContain(veg.accountId);
    expect(providers).not.toContain(nonveg.accountId);
    expect(providers).not.toContain(far.accountId);
  });

  it('tells the requester plainly when nobody fits, then offers the request to a provider who joins later', async () => {
    const asker = await newUser('Lonely');
    const requestId = await ask(asker, 'I need a kathak dance teacher for my daughter', MUMBAI);
    const res = await matching.dispatchRequest(requestId);
    expect(res.reason).toBe('no_match');
    expect((await matching.getRequest(asker, requestId)).status).toBe('no_match');
    expect(await matchesFor(requestId)).toHaveLength(0);

    const teacher = await newUser('Teacher');
    const [capId] = await offer(teacher, 'I teach kathak dance to children and adults', MUMBAI);
    expect(await matching.matchNewCapability(capId!)).toBe(1);
    expect((await matchesFor(requestId)).map((m) => m.provider_account_id)).toEqual([teacher.accountId]);
  });

  it('sends bounded waves, never repeats a provider, and stops at the cap', async () => {
    const plumbers = [];
    for (let i = 0; i < 17; i++) {
      const p = await newUser(`Plumber${i}`);
      await offer(p, 'I am a plumber, I fix tap leaks and pipe fitting');
      plumbers.push(p);
    }
    const asker = await newUser('Leaky');
    const requestId = await ask(asker, 'Need a plumber to fix a leaking tap');
    const first = await matching.dispatchRequest(requestId);
    expect((await matchesFor(requestId)).length).toBe(5);
    await matching.expireWave(first.waveId!);
    expect((await matchesFor(requestId)).length).toBe(10);
    const waves = await asSystem((tx) => tx.query(`SELECT id FROM dispatch_waves WHERE request_id = $1 AND state = 'open'`, [requestId]));
    await matching.expireWave(waves[0]!.id);
    const all = await matchesFor(requestId);
    expect(all.length).toBe(15);
    expect(new Set(all.map((m) => m.provider_account_id)).size).toBe(15);
    const open = await asSystem((tx) => tx.query(`SELECT id FROM dispatch_waves WHERE request_id = $1 AND state = 'open'`, [requestId]));
    await matching.expireWave(open[0]!.id);
    expect((await matchesFor(requestId)).length).toBe(15); // capped at three waves
  });

  it('respects pause and blocks', async () => {
    const paused = await newUser('Paused');
    await offer(paused, 'I do mehendi for weddings and functions');
    await identity.updateProviderSettings(paused, { paused: true });
    const blocked = await newUser('Blocked');
    await offer(blocked, 'Bridal mehendi artist, mehendi designs');
    const ok = await newUser('Ok');
    await offer(ok, 'Mehendi artist for all occasions');
    const asker = await newUser('Bride');
    await safety.block(asker, blocked.accountId);
    const requestId = await ask(asker, 'Looking for a mehendi artist for my wedding');
    await matching.dispatchRequest(requestId);
    const providers = (await matchesFor(requestId)).map((m) => m.provider_account_id);
    expect(providers).toEqual([ok.accountId]);
  });
});

describe('provider profile', () => {
  it('lets a provider re-describe a service and widen their area without losing its history', async () => {
    const pro = await newUser('Baker');
    const [capId] = await offer(pro, 'I bake cakes for birthdays');
    const far = { lat: 18.62, lng: 73.80 }; // about 13 km away: outside the default 5 km
    const asker = await newUser('Party');
    const requestId = await ask(asker, 'Need 20 cupcakes for a party', far);
    await matching.dispatchRequest(requestId);
    expect(await matchesFor(requestId)).toHaveLength(0);

    await intake.setServiceArea(pro, { serviceRadiusM: 20000 });
    expect((await intake.getServiceArea(pro))!.serviceRadiusM).toBe(20000);
    expect(await matching.matchNewCapability(capId!)).toBe(1);

    const draft = await intake.interpretUtterance(pro, { purpose: 'capability', text: 'I bake cakes, cupcakes and brownies, home delivery' });
    await intake.reviseCapability(pro, capId!, draft.drafts[0]!.interpretationId);
    const caps = await intake.listCapabilities(pro);
    expect(caps).toHaveLength(1);
    expect(caps[0]!.id).toBe(capId);
    expect(caps[0]!.originalText).toContain('brownies');
    expect(caps[0]!.attributes.delivery).toBe(true);
    const stranger = await newUser('Nosy');
    await expectCode(intake.reviseCapability(stranger, capId!, draft.drafts[0]!.interpretationId), 'draft_not_found');
  });
});

describe('privacy boundaries', () => {
  it('shows a requester only the matched capability and keeps conversations closed to outsiders', async () => {
    const multi = await newUser('Multi');
    await offer(multi, 'I teach guitar to beginners');
    await offer(multi, 'I repair laptop and do screen replacement for phones');
    const asker = await newUser('Student');
    const stranger = await newUser('Stranger');
    const requestId = await ask(asker, 'I want to learn guitar on weekends');
    await matching.dispatchRequest(requestId);
    const match = (await matchesFor(requestId))[0]!;
    expect(match.provider_account_id).toBe(multi.accountId);

    // A stranger and the requester cannot respond on the provider's behalf.
    await expectCode(matching.respondToMatch(stranger, match.id, 'interested'), 'match_not_found');
    await expectCode(matching.respondToMatch(asker, match.id, 'interested'), 'match_not_found');
    const { conversationId } = await matching.respondToMatch(multi, match.id, 'interested');

    const view = await matching.getRequest(asker, requestId);
    const serialised = JSON.stringify(view);
    expect(view.responders).toHaveLength(1);
    expect(serialised).toContain('guitar');
    expect(serialised).not.toContain('laptop');
    expect(serialised).not.toContain(multi.phone);
    await expectCode(matching.getRequest(stranger, requestId), 'request_not_found');

    await conversations.sendMessage(asker, conversationId!, { clientMessageId: randomUUID(), body: 'Hello, are you free on Saturday?' });
    await expectCode(conversations.listMessages(stranger, conversationId!), 'conversation_not_found');
    await expectCode(conversations.sendMessage(stranger, conversationId!, { clientMessageId: randomUUID(), body: 'hi' }), 'conversation_not_found');
    await expectCode(conversations.shareNumber(stranger, conversationId!), 'conversation_not_found');
    await expectCode(trust.proposeAgreement(stranger, conversationId!, { what: 'x', scheduledFor: new Date(Date.now() + 3600_000).toISOString() }), 'conversation_not_found');

    // Row-level security is the second layer: a query with no application check still returns nothing.
    const leaked = await asActor(stranger.accountId, async (tx) => ({
      messages: await tx.query(`SELECT 1 FROM messages`),
      conversations: await tx.query(`SELECT 1 FROM conversations`),
      capabilities: await tx.query(`SELECT 1 FROM capabilities WHERE account_id <> $1`, [stranger.accountId]),
      versions: await tx.query(`SELECT 1 FROM capability_versions WHERE account_id <> $1`, [stranger.accountId]),
    }));
    expect(leaked).toEqual({ messages: [], conversations: [], capabilities: [], versions: [] });

    // The provider's conversation list shows the request, not the requester's phone.
    expect(JSON.stringify(await conversations.listConversations(multi))).not.toContain(asker.phone);
  });

  it('reveals a phone number only through an explicit share, and only inside that chat', async () => {
    const tutor = await newUser('Tutor');
    await offer(tutor, 'I teach maths tuition for class 10');
    const parent = await newUser('Parent');
    const requestId = await ask(parent, 'Need maths tuition for class 10');
    await matching.dispatchRequest(requestId);
    const match = (await matchesFor(requestId))[0]!;
    const { conversationId } = await matching.respondToMatch(tutor, match.id, 'interested');

    const before = JSON.stringify([
      await conversations.getConversation(parent, conversationId!),
      await conversations.listMessages(parent, conversationId!),
      await matching.getRequest(parent, requestId),
      await matching.listIncoming(tutor),
    ]);
    expect(before).not.toContain(tutor.phone);
    expect(before).not.toContain(parent.phone);

    await conversations.shareNumber(tutor, conversationId!);
    await conversations.shareNumber(tutor, conversationId!); // idempotent
    const msgs = await conversations.listMessages(parent, conversationId!);
    const shares = msgs.filter((m) => m.kind === 'contact_share');
    expect(shares).toHaveLength(1);
    expect(shares[0]!.meta.phone).toBe(tutor.phone);
    // Sharing is one-directional: the parent's number is still private.
    expect(JSON.stringify(await conversations.listMessages(tutor, conversationId!))).not.toContain(parent.phone);
    // The number is not stored in clear text.
    const raw = await asSystem((tx) => tx.query(`SELECT meta::text AS meta FROM messages WHERE conversation_id = $1`, [conversationId]));
    expect(JSON.stringify(raw)).not.toContain(tutor.phone);
  });
});

describe('chat', () => {
  it('stores a retried message once and keeps sequence order', async () => {
    const a = await newUser('Tailor');
    await offer(a, 'I do tailoring, blouse stitching and alteration');
    const b = await newUser('Customer');
    const requestId = await ask(b, 'Need blouse stitching done this week');
    await matching.dispatchRequest(requestId);
    const match = (await matchesFor(requestId))[0]!;
    const { conversationId } = await matching.respondToMatch(a, match.id, 'interested');
    const clientMessageId = randomUUID();
    const first = await conversations.sendMessage(b, conversationId!, { clientMessageId, body: 'Can you do it by Friday?' });
    const retry = await conversations.sendMessage(b, conversationId!, { clientMessageId, body: 'Can you do it by Friday?' });
    expect(retry.id).toBe(first.id);
    await Promise.all([1, 2, 3, 4, 5].map((n) => conversations.sendMessage(a, conversationId!, { clientMessageId: randomUUID(), body: `msg ${n}` })));
    const all = await conversations.listMessages(a, conversationId!);
    expect(all.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // Catch-up after reconnect returns only what the client has not seen.
    const synced = await conversations.sync(b, { [conversationId!]: 4 });
    expect(synced[conversationId!]!.map((m) => m.seq)).toEqual([5, 6]);

    // Read receipts clear the unread count and never run ahead of what exists.
    expect((await conversations.listConversations(b)).find((c) => c.id === conversationId)!.unread).toBe(5);
    await conversations.updateReceipts(b, conversationId!, { readSeq: 999 });
    const afterRead = (await conversations.listConversations(b)).find((c) => c.id === conversationId)!;
    expect(afterRead.unread).toBe(0);
    expect((await conversations.getConversation(a, conversationId!)).theirReadSeq).toBe(6);

    const warned = await conversations.sendMessage(a, conversationId!, { clientMessageId: randomUUID(), body: 'Please send advance on UPI first' });
    expect(warned.meta.scamWarning).toBe(true);

    await safety.block(b, a.accountId);
    await expectCode(conversations.sendMessage(a, conversationId!, { clientMessageId: randomUUID(), body: 'hello?' }), 'blocked');
  });
});

describe('agreement, confirmation and ratings', () => {
  it('rates only completed jobs and hides ratings until both sides have rated', async () => {
    const pro = await newUser('Electrician');
    const [capId] = await offer(pro, 'I am an electrician, wiring and fan repair');
    const other = await newUser('OtherElectrician');
    await offer(other, 'Electrician for switch and light fitting');
    const client = await newUser('Client');
    const requestId = await ask(client, 'Need an electrician for fan repair');
    await matching.dispatchRequest(requestId);
    const ms = await matchesFor(requestId);
    const mine = ms.find((m) => m.provider_account_id === pro.accountId)!;
    const theirs = ms.find((m) => m.provider_account_id === other.accountId)!;
    const { conversationId } = await matching.respondToMatch(pro, mine.id, 'interested');
    await matching.respondToMatch(other, theirs.id, 'interested');

    const proposed = await trust.proposeAgreement(client, conversationId!, { what: 'Fan repair', scheduledFor: new Date(Date.now() - 60_000).toISOString(), priceMinor: 30000 });
    await expectCode(trust.confirmAgreement(client, proposed.id), 'other_party_must_confirm');
    await expectCode(trust.rate(client, proposed.id, { stars: 5 }), 'job_not_completed');
    await trust.confirmAgreement(pro, proposed.id);

    // Agreeing closes the request and tells the other responder it is filled.
    expect((await matching.getRequest(client, requestId)).status).toBe('agreed');
    expect((await matchesFor(requestId)).find((m) => m.id === theirs.id)!.state).toBe('filled');

    await trust.answerJob(client, proposed.id, 'yes');
    expect((await trust.getAgreement(pro, conversationId!))!.state).toBe('confirmed');
    await trust.answerJob(pro, proposed.id, 'yes');
    expect((await trust.getAgreement(pro, conversationId!))!.state).toBe('completed');

    await trust.rate(client, proposed.id, { stars: 5, tags: ['on time'] });
    await expectCode(trust.rate(client, proposed.id, { stars: 1 }), 'already_rated');
    // One-sided rating: not visible, and the trust line has not moved.
    expect((await trust.getAgreement(pro, conversationId!))!.theirRating).toBeNull();
    let caps = await intake.listCapabilities(pro);
    expect(caps.find((c) => c.id === capId)!.trust).toMatchObject({ completedJobs: 1, ratingCount: 0, ratingAvg: null });

    await trust.rate(pro, proposed.id, { stars: 4 });
    expect((await trust.getAgreement(pro, conversationId!))!.theirRating!.stars).toBe(5);
    caps = await intake.listCapabilities(pro);
    expect(caps.find((c) => c.id === capId)!.trust).toMatchObject({ completedJobs: 1, ratingCount: 1, ratingAvg: 5 });
    // The responder trust line the next requester sees carries the rating.
    expect((await matching.getRequest(client, requestId)).responders.find((r) => r.matchId === mine.id)!.trust.ratingAvg).toBe(5);
  });

  it('marks a job disputed when the two sides disagree, and refuses ratings between accounts on one device', async () => {
    const device = randomUUID();
    const pro = await newUser('Painter', device);
    await offer(pro, 'House painting and waterproofing work');
    const client = await newUser('Owner', device);
    const requestId = await ask(client, 'Need house painting for 2 rooms');
    await matching.dispatchRequest(requestId);
    const match = (await matchesFor(requestId))[0]!;
    const { conversationId } = await matching.respondToMatch(pro, match.id, 'interested');
    const a = await trust.proposeAgreement(pro, conversationId!, { what: 'Paint 2 rooms', scheduledFor: new Date(Date.now() - 1000).toISOString() });
    await trust.confirmAgreement(client, a.id);
    await trust.answerJob(client, a.id, 'yes');
    await trust.answerJob(pro, a.id, 'yes');
    await expectCode(trust.rate(client, a.id, { stars: 5 }), 'same_device');

    const pro2 = await newUser('Painter2');
    await offer(pro2, 'Wall painting and whitewash');
    const client2 = await newUser('Owner2');
    const r2 = await ask(client2, 'Need wall painting done');
    await matching.dispatchRequest(r2);
    const m2 = (await matchesFor(r2)).find((m) => m.provider_account_id === pro2.accountId)!;
    const c2 = await matching.respondToMatch(pro2, m2.id, 'interested');
    const a2 = await trust.proposeAgreement(pro2, c2.conversationId!, { what: 'Paint', scheduledFor: new Date(Date.now() - 1000).toISOString() });
    await trust.confirmAgreement(client2, a2.id);
    await trust.answerJob(client2, a2.id, 'no');
    await trust.answerJob(pro2, a2.id, 'yes');
    expect((await trust.getAgreement(client2, c2.conversationId!))!.state).toBe('disputed');
  });
});

describe('notifications', () => {
  it('pushes without request detail, records receipts, and falls back to SMS only when no receipt arrives', async () => {
    const seen = await newUser('Seen');
    await offer(seen, 'Yoga teacher for morning batches');
    await identity.updateDevice(seen, { pushToken: 'ExponentPushToken[seen]' });
    const silent = await newUser('Silent');
    await offer(silent, 'I teach yoga and pilates');
    await identity.updateDevice(silent, { pushToken: 'ExponentPushToken[silent]' });
    const asker = await newUser('Yogi');
    const requestId = await ask(asker, 'Looking for a yoga teacher near Kothrud at 6 am');
    const { waveId } = await matching.dispatchRequest(requestId);
    devOutbox.push.length = 0;
    devOutbox.sms.length = 0;
    await notifications.notifyWave(waveId!);
    expect(devOutbox.push).toHaveLength(2);
    for (const p of devOutbox.push) {
      expect(p.channelId).toBe('requests');
      expect(JSON.stringify(p)).not.toContain('Kothrud');
    }
    const ms = await matchesFor(requestId);
    const seenMatch = ms.find((m) => m.provider_account_id === seen.accountId)!;
    const silentMatch = ms.find((m) => m.provider_account_id === silent.accountId)!;
    await matching.acknowledge(seen, seenMatch.id, 'delivered');
    expect(await notifications.smsFallback(seenMatch.id)).toBe('skipped');
    expect(await notifications.smsFallback(silentMatch.id)).toBe('sent');
    expect(await notifications.smsFallback(silentMatch.id)).toBe('skipped');
    expect(devOutbox.sms).toHaveLength(1);
    expect(devOutbox.sms[0]!.phone).toBe(silent.phone);
    expect(devOutbox.sms[0]!.text).not.toContain('yoga');

    await matching.acknowledge(seen, seenMatch.id, 'opened');
    expect((await matching.getRequest(asker, requestId)).seen).toBe(1);
  });
});

describe('account deletion', () => {
  it('removes personal data and stops matching', async () => {
    const gone = await newUser('Leaving');
    await offer(gone, 'I do pest control for cockroach and termite');
    await identity.deleteAccount(gone);
    const row = await asSystem((tx) => tx.one(`SELECT phone_enc, phone_hash, display_name, status FROM accounts WHERE id = $1`, [gone.accountId]));
    expect(row).toEqual({ phone_enc: null, phone_hash: null, display_name: null, status: 'deleted' });
    const asker = await newUser('Buggy');
    const requestId = await ask(asker, 'Need pest control for cockroach problem');
    await matching.dispatchRequest(requestId);
    expect((await matchesFor(requestId)).map((m) => m.provider_account_id)).not.toContain(gone.accountId);
    // The same phone can register again as a fresh account.
    const { devCode } = await identity.startOtp(gone.phone, '10.9.9.9');
    const again = await identity.verifyOtp({ phone: gone.phone, code: devCode!, deviceId: randomUUID(), platform: 'android' });
    expect(again.isNew).toBe(true);
  });
});
