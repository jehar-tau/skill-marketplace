// Demo data for local development: a handful of providers around Pune so a
// request typed into the app has someone to reach. Run with: pnpm db:seed
import { config } from './config';
import { asSystem, closePools } from './db';
import * as identity from './modules/identity';
import * as intake from './modules/intake';
import { redis } from './redis';

if (config.isProd) {
  console.error('The seed script is for development only.');
  process.exit(1);
}

const PROVIDERS: [string, string, number, number, string[]][] = [
  ['9800000001', 'Sunita Kulkarni', 18.5204, 73.8567, ['मला घरगुती चिकन बिर्याणी बनवता येते. एक ते पाच किलोपर्यंत ऑर्डर घेऊ शकते, घरपोच देते', 'मी दहावीपर्यंत गणित शिकवते']],
  ['9800000002', 'Anjali Deshmukh', 18.5074, 73.8077, ['I make pure veg thali, paneer sabzi and veg pulao, home delivery', 'I bake cakes and cupcakes for birthdays']],
  ['9800000003', 'Ramesh Pawar', 18.531, 73.8475, ['I am a plumber, I fix tap leaks, pipe fitting and water tank work', 'Electrician work also: wiring, fan repair, switch fitting']],
  ['9800000004', 'Imran Shaikh', 18.5362, 73.8939, ['AC repair and service, fridge and washing machine repair']],
  ['9800000005', 'Priya Joshi', 18.559, 73.7868, ['मी गिटार शिकवते, लहान मुलांना आणि मोठ्यांना', 'I build websites and landing pages for small businesses']],
  ['9800000006', 'Kavita More', 18.5187, 73.9348, ['Bridal mehendi artist, mehendi for all functions', 'Tailoring, blouse stitching and alteration']],
  ['9800000007', 'Suresh Jadhav', 18.4712, 73.8193, ['House painting and waterproofing', 'Carpenter work, furniture and door repair']],
  ['9800000008', 'Meera Iyer', 18.5679, 73.9143, ['Yoga teacher, morning batches at home or online', 'Spoken English classes for adults']],
];

for (const [phone, name, lat, lng, skills] of PROVIDERS) {
  const { devCode } = await identity.startOtp(phone, '127.0.0.1');
  if (!devCode) throw new Error('Seeding needs OTP_PROVIDER=dev');
  const session = await identity.verifyOtp({ phone, code: devCode, deviceId: `seed-device-${phone}`, platform: 'android', locale: 'mr' });
  const actor = await identity.authenticate(session.accessToken);
  await identity.updateMe(actor, { displayName: name });
  // Demo providers take requests at any hour so the app can be tried at night.
  await asSystem((tx) => tx.exec(`UPDATE provider_settings SET quiet_start = '00:00', quiet_end = '00:00', daily_cap = 200 WHERE account_id = $1`, [actor.accountId]));
  const existing = await intake.listCapabilities(actor);
  if (existing.length > 0) {
    console.log(`${name}: already has ${existing.length} skill(s)`);
    continue;
  }
  for (const text of skills) {
    const res = await intake.interpretUtterance(actor, { purpose: 'capability', text });
    await intake.confirmCapabilities(actor, { interpretationIds: res.drafts.map((d) => d.interpretationId), location: { lat, lng }, serviceRadiusM: 12000 });
  }
  console.log(`${name}: ${skills.length} description(s) added`);
}
console.log('\nSign in to the app as any seeded provider with phone 9800000001 … 9800000008 to see their side.');
await closePools();
redis.disconnect();
