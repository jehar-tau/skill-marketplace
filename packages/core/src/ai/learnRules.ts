// Profile learning without any AI service: fixed patterns that pick prices,
// notice periods, delivery, timings and praise out of an English chat. It costs
// nothing to run and never sends text anywhere. It only reads English: a chat that
// is mostly in another language is left alone rather than misread.

import type { ChatForLearning, ChatLearning } from './learn';
import { redact } from './learn';

const OTHER_LANGUAGE_WORDS = /\b(mala|pahije|aahe|ahe|nahi|kiti|kadhi|karto|karte|hoil|mujhe|chahiye|kitna|kab|nahin|hoga|karunga|karungi|kya|hai|hain|aap|tumhi|bhaiya|didi)\b/gi;

// True when the chat is English enough for the patterns below to be trusted.
export function mostlyEnglish(lines: { text: string }[]): boolean {
  const all = lines.map((l) => l.text).join(' ');
  const letters = all.replace(/[^\p{L}]/gu, '');
  if (letters.length < 20) return false;
  const latin = letters.replace(/[^A-Za-z]/g, '').length;
  if (latin / letters.length < 0.9) return false;
  const words = all.split(/\s+/).length;
  const foreign = (all.match(OTHER_LANGUAGE_WORDS) ?? []).length;
  return foreign / Math.max(words, 1) < 0.08;
}

const PER = '(kg|kilo|plate|person|head|hour|hr|month|day|session|class|piece|visit|sq\\.? ?ft|room)';
const PRICE = new RegExp(`(?:rs\\.?|₹|inr|rupees)\\s*(\\d{2,6})(?:\\s*(?:per|/|a|an|each)\\s*${PER})?|(\\d{2,6})\\s*(?:rs\\.?|₹|rupees|/-)(?:\\s*(?:per|/|a|an|each)\\s*${PER})?`, 'i');
const PRAISE: [RegExp, string][] = [
  [/\b(on time|punctual|came early|before time)\b/i, 'A customer praised being on time'],
  [/\b(neat|clean work|tidy|cleaned up)\b/i, 'A customer praised neat, clean work'],
  [/\b(delicious|tasty|yummy|loved the (food|taste|biryani|cake))\b/i, 'A customer praised the taste'],
  [/\b(polite|friendly|patient|kind)\b/i, 'A customer praised a friendly, patient manner'],
  [/\b(explains? (it |things )?well|clear(ly)? explain|understood (it|everything) (now|well))\b/i, 'A customer praised clear explanations'],
  [/\b(reasonable|fair price|worth (it|the money)|affordable)\b/i, 'A customer found the price fair'],
  [/\b(excellent|amazing|fantastic|great (job|work)|very good (job|work)|well done|perfect|highly recommend|will (call|order|come) again)\b/i, 'A customer was very happy with the work'],
];

export async function extractWithRules(chat: ChatForLearning): Promise<ChatLearning> {
  if (!mostlyEnglish(chat.lines)) return { facts: [] };
  const facts: ChatLearning['facts'] = [];
  const add = (kind: ChatLearning['facts'][number]['kind'], text: string) => {
    if (!facts.some((f) => f.text === text) && facts.length < 10) facts.push({ kind, text });
  };
  const provider = chat.lines.filter((l) => l.who === 'PROVIDER').map((l) => redact(l.text));
  const customer = chat.lines.filter((l) => l.who === 'CUSTOMER').map((l) => redact(l.text));

  // An agreed job is the most reliable fact there is: both sides confirmed it.
  if (chat.agreed) {
    const what = redact(chat.agreed.what).slice(0, 80);
    add('offering', `Took a job: ${what}`);
    if (chat.agreed.priceRupees) add('price', `Agreed Rs ${chat.agreed.priceRupees} for: ${what}`);
  }

  for (const line of provider) {
    // Only prices the provider said themselves; a customer's offer is not their price.
    const p = PRICE.exec(line);
    if (p) {
      const amount = p[1] ?? p[3];
      const per = (p[2] ?? p[4])?.toLowerCase();
      add('price', `Quoted Rs ${amount}${per ? ` per ${per}` : ''}`);
    }
    const notice = /(\d+|one|two|three)\s*(hours?|hrs?|days?)\s*(?:of\s+|'s\s+)?(?:advance\s+)?(notice|in advance|advance|before|prior|earlier)/i.exec(line);
    if (notice) add('working_style', `Asks for ${notice[1]} ${notice[2]!.toLowerCase()} notice`);
    if (/\b(no delivery|pick ?up only|you (will )?(have|need) to (collect|pick))/i.test(line)) add('working_style', 'Pickup only, does not deliver');
    else if (/\b((i|we)('ll| will| can)? deliver|home delivery|free delivery|delivery (is )?(available|included|possible))/i.test(line)) add('working_style', 'Delivers');
    if (/\b(i|we)('ll| will| can)? come (to|at) (your|ur) (home|house|place)|home visit/i.test(line)) add('working_style', 'Comes to the customer\'s home');
    const when = /\b(?:available|free|work|take (?:orders|classes)|come)\b[^.]{0,30}\b(weekends?|saturdays?|sundays?|weekdays|evenings?|mornings?|after \d{1,2}\s?(?:am|pm))/i.exec(line);
    if (when) add('working_style', `Usually available: ${when[1]!.toLowerCase()}`);
    if (/\b(online|video call|zoom|google meet)\b/i.test(line) && /\b(class|session|teach|lesson)/i.test(line)) add('working_style', 'Offers online sessions');
  }

  for (const line of customer) {
    for (const [re, text] of PRAISE) if (re.test(line)) add('strength', text);
  }
  return { facts };
}
