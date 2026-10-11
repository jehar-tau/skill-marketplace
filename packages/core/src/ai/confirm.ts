// Confirmation shown to the user before anything is dispatched or activated
// (spec §10). It is built from the structured facts, not written by a model, so
// what the user approves is exactly what will be stored.

import { CATEGORY_BY_SLUG, type Attributes, type Locale } from '@sm/contracts';

const T = {
  en: {
    offer: 'You offer', need: 'You need', correct: 'Is this right?',
    diet: { veg: 'vegetarian', nonveg: 'non-vegetarian', egg: 'with egg', jain: 'Jain' },
    qty: (n: number, u: string) => `${n} ${u}`,
    range: (a: number, b: number, u: string) => `orders from ${a} to ${b} ${u}`,
    upTo: (b: number, u: string) => `orders up to ${b} ${u}`,
    from: (a: number, u: string) => `orders from ${a} ${u}`,
    delivers: 'you deliver', wantsDelivery: 'delivery needed', noDelivery: 'no delivery',
    notice: (h: number) => `${h} hours notice needed`,
    price: (p: number, per?: string) => `₹${p}${per ? ' per ' + per : ''}`,
    by: (d: string) => `by ${d}`,
    mode: { online: 'online', in_person: 'in person', either: 'online or in person' },
    units: { kg: 'kg', g: 'g', plates: 'plates', people: 'people', pieces: 'pieces', litres: 'litres', hours: 'hours', sessions: 'sessions' },
    today: 'today', tomorrow: 'tomorrow',
  },
  hi: {
    offer: 'आप यह सेवा देते हैं', need: 'आपको चाहिए', correct: 'क्या यह सही है?',
    diet: { veg: 'शाकाहारी', nonveg: 'मांसाहारी', egg: 'अंडा सहित', jain: 'जैन' },
    qty: (n: number, u: string) => `${n} ${u}`,
    range: (a: number, b: number, u: string) => `${a} से ${b} ${u} तक के ऑर्डर`,
    upTo: (b: number, u: string) => `${b} ${u} तक के ऑर्डर`,
    from: (a: number, u: string) => `${a} ${u} से ऑर्डर`,
    delivers: 'आप डिलीवरी करते हैं', wantsDelivery: 'डिलीवरी चाहिए', noDelivery: 'डिलीवरी नहीं',
    notice: (h: number) => `${h} घंटे पहले बताना होगा`,
    price: (p: number, per?: string) => `₹${p}${per ? ' प्रति ' + per : ''}`,
    by: (d: string) => `${d} तक`,
    mode: { online: 'ऑनलाइन', in_person: 'आमने-सामने', either: 'ऑनलाइन या आमने-सामने' },
    units: { kg: 'किलो', g: 'ग्राम', plates: 'प्लेट', people: 'लोग', pieces: 'नग', litres: 'लीटर', hours: 'घंटे', sessions: 'सत्र' },
    today: 'आज', tomorrow: 'कल',
  },
  mr: {
    offer: 'तुम्ही ही सेवा देता', need: 'तुम्हाला हवे आहे', correct: 'बरोबर?',
    diet: { veg: 'शाकाहारी', nonveg: 'मांसाहारी', egg: 'अंड्यासह', jain: 'जैन' },
    qty: (n: number, u: string) => `${n} ${u}`,
    range: (a: number, b: number, u: string) => `${a} ते ${b} ${u} पर्यंतच्या ऑर्डर`,
    upTo: (b: number, u: string) => `${b} ${u} पर्यंतच्या ऑर्डर`,
    from: (a: number, u: string) => `${a} ${u} पासून ऑर्डर`,
    delivers: 'तुम्ही घरपोच देता', wantsDelivery: 'घरपोच हवे', noDelivery: 'घरपोच नाही',
    notice: (h: number) => `${h} तास आधी सांगावे लागेल`,
    price: (p: number, per?: string) => `₹${p}${per ? ' प्रति ' + per : ''}`,
    by: (d: string) => `${d} पर्यंत`,
    mode: { online: 'ऑनलाइन', in_person: 'प्रत्यक्ष', either: 'ऑनलाइन किंवा प्रत्यक्ष' },
    units: { kg: 'किलो', g: 'ग्रॅम', plates: 'प्लेट', people: 'जण', pieces: 'नग', litres: 'लिटर', hours: 'तास', sessions: 'सत्रे' },
    today: 'आज', tomorrow: 'उद्या',
  },
} as const;

const IST_MS = 330 * 60_000;

export function formatDeadline(iso: string, locale: Locale, now = new Date()): string {
  const t = T[locale];
  const d = new Date(new Date(iso).getTime() + IST_MS);
  const n = new Date(now.getTime() + IST_MS);
  const dayDiff = Math.round(
    (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())) / 86_400_000,
  );
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const time = `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
  const day = dayDiff === 0 ? t.today : dayDiff === 1 ? t.tomorrow : `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  return `${day} ${time}`;
}

// Every quantity, price, date, diet and delivery fact appears here, because those
// are the ones a wrong reading would hurt most.
export function confirmationText(
  locale: Locale,
  purpose: 'capability' | 'request',
  categorySlug: string,
  attrs: Attributes,
  deadlineAt: string | null,
): string {
  const t = T[locale];
  const label = CATEGORY_BY_SLUG.get(categorySlug)?.labels[locale] ?? categorySlug;
  const unit = attrs.unit ? t.units[attrs.unit] : '';
  const facts: string[] = [];
  const head = attrs.item ? `${attrs.item} (${label})` : attrs.subject ? `${attrs.subject} (${label})` : label;
  if (attrs.subject && attrs.item) facts.push(attrs.subject);
  if (attrs.grade) facts.push(attrs.grade);
  if (attrs.diet) facts.push(t.diet[attrs.diet]);
  if (attrs.quantity !== undefined) facts.push(t.qty(attrs.quantity, unit));
  if (attrs.quantity_min !== undefined && attrs.quantity_max !== undefined) facts.push(t.range(attrs.quantity_min, attrs.quantity_max, unit));
  else if (attrs.quantity_max !== undefined) facts.push(t.upTo(attrs.quantity_max, unit));
  else if (attrs.quantity_min !== undefined) facts.push(t.from(attrs.quantity_min, unit));
  if (attrs.delivery === true) facts.push(purpose === 'request' ? t.wantsDelivery : t.delivers);
  if (attrs.delivery === false) facts.push(t.noDelivery);
  if (attrs.mode) facts.push(t.mode[attrs.mode]);
  if (attrs.notice_hours !== undefined) facts.push(t.notice(attrs.notice_hours));
  if (attrs.price_amount !== undefined) facts.push(t.price(attrs.price_amount, attrs.price_per));
  if (deadlineAt) facts.push(t.by(formatDeadline(deadlineAt, locale)));
  const lead = purpose === 'capability' ? t.offer : t.need;
  return `${lead}: ${head}${facts.length ? ' — ' + facts.join(' · ') : ''}. ${t.correct}`;
}
