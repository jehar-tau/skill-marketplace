// Built-in keyword interpreter. It needs no network or key, so it is both the
// development default and the fallback when the hosted model is slow, down or
// over its spend cap (spec §10). It never invents price, delivery or location:
// every attribute comes from a pattern matched in the user's own words.

import { CATEGORIES, type Attributes, type CategoryDef, type Locale } from '@sm/contracts';
import type { InterpretedItem, InterpretOutput } from './types';

const DEVANAGARI = /[ऀ-ॿ]/;
const MR_MARKERS = ['आहे', 'मला', 'पाहिजे', 'येते', 'येतो', 'करतो', 'करते', 'आणि', 'वाजे', 'घरगुती', 'हवे', 'हवा', 'हवी', 'मी', 'शिकवतो', 'शिकवते', 'उद्या', 'शकतो', 'शकते'];
const HI_MARKERS = ['है', 'हूँ', 'हूं', 'मुझे', 'चाहिए', 'करता', 'करती', 'और', 'बजे', 'मैं', 'सकता', 'सकती', 'पढ़ाता', 'कल'];
const MR_ROMAN = ['mala', 'pahije', 'aahe', 'ahe', 'yete', 'yeto', 'karto', 'karte', 'ani', 'udya', 'havi', 'hava', 'shikavto', 'banvata'];
const HI_ROMAN = ['mujhe', 'chahiye', 'hai', 'hoon', 'hun', 'karta', 'karti', 'aur', 'banata', 'banati', 'sikhata'];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  एक: 1, दोन: 2, दो: 2, तीन: 3, चार: 4, पाच: 5, पांच: 5, पाँच: 5, सहा: 6, छह: 6, सात: 7, आठ: 8, नऊ: 9, नौ: 9, दहा: 10, दस: 10,
  ek: 1, don: 2, teen: 3, char: 4, pach: 5, paanch: 5,
};

// Devanagari and Romanised terms -> English, for the derived canonical text only.
const GLOSS: Record<string, string> = {
  बिर्याणी: 'biryani', बिरयानी: 'biryani', चिकन: 'chicken', मटण: 'mutton', पनीर: 'paneer', पुलाव: 'pulao', भाजी: 'sabzi',
  सब्जी: 'sabzi', थाळी: 'thali', थाली: 'thali', जेवण: 'meal', खाना: 'meal', पोळी: 'chapati', चपाती: 'chapati', रोटी: 'roti',
  मिसळ: 'misal', पावभाजी: 'pav bhaji', टिफिन: 'tiffin', डबा: 'tiffin', केक: 'cake', लाडू: 'ladoo', लड्डू: 'ladoo', चिवडा: 'chivda',
  चकली: 'chakli', मोदक: 'modak', फराळ: 'festive snacks', गणित: 'maths', विज्ञान: 'science', शिकवणी: 'tuition', ट्यूशन: 'tuition',
  गिटार: 'guitar', तबला: 'tabla', गाणे: 'singing', गाना: 'singing', नृत्य: 'dance', चित्रकला: 'drawing', प्लंबर: 'plumber',
  नळ: 'tap', नल: 'tap', गळती: 'leak', सुतार: 'carpenter', बढ़ई: 'carpenter', इलेक्ट्रिशियन: 'electrician', इलेक्ट्रीशियन: 'electrician',
  वायरिंग: 'wiring', पंखा: 'fan', सफाई: 'cleaning', साफसफाई: 'cleaning', रंगकाम: 'house painting', मेहंदी: 'mehendi',
  शिवणकाम: 'tailoring', सिलाई: 'tailoring', ब्लाउज: 'blouse', योग: 'yoga', योगा: 'yoga', फोटोग्राफर: 'photographer',
  फोटोग्राफी: 'photography', सजावट: 'decoration', पूजा: 'pooja', वेबसाइट: 'website', लोगो: 'logo', ड्रायव्हर: 'driver',
  ड्राइवर: 'driver', एसी: 'AC', फ्रिज: 'fridge', दुरुस्ती: 'repair', मरम्मत: 'repair', भाषांतर: 'translation', अनुवाद: 'translation',
};

const SUBJECTS: [RegExp, string][] = [
  [/\b(maths?|mathematics)\b|गणित/i, 'maths'], [/\bscience\b|विज्ञान/i, 'science'], [/\bphysics\b|भौतिक/i, 'physics'],
  [/\bchemistry\b|रसायन/i, 'chemistry'], [/\bbiology\b|जीवशास्त्र|जीव विज्ञान/i, 'biology'], [/\benglish\b|इंग्रजी|अंग्रेजी/i, 'english'],
  [/\bmarathi\b|मराठी/i, 'marathi'], [/\bhindi\b|हिंदी/i, 'hindi'], [/\bsanskrit\b|संस्कृत/i, 'sanskrit'],
  [/\baccounts?\b|accountancy/i, 'accounts'], [/\bguitar\b|गिटार/i, 'guitar'], [/\btabla\b|तबला/i, 'tabla'],
  [/\bkeyboard\b|\bpiano\b/i, 'keyboard'], [/\bdrawing\b|चित्रकला/i, 'drawing'], [/\bkathak\b|कथक/i, 'kathak'],
];

const UNIT_PATTERNS: [string, Attributes['unit']][] = [
  ['kgs?|kilos?|kilograms?|किलो(?:पर्यंत)?', 'kg'], ['grams?|gms?|ग्रॅम|ग्राम', 'g'], ['plates?|प्लेट', 'plates'],
  ['people|persons?|guests?|लोकांसाठी|लोक|लोगों|लोग|जणांसाठी|जण|माणसे', 'people'], ['pieces?|pcs|नग', 'pieces'],
  ['litres?|liters?|लिटर|लीटर', 'litres'],
];

export function toAsciiDigits(text: string): string {
  return text.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}

export function detectLocale(text: string, hint?: Locale): Locale {
  if (DEVANAGARI.test(text)) {
    const mr = MR_MARKERS.filter((w) => text.includes(w)).length;
    const hi = HI_MARKERS.filter((w) => text.includes(w)).length;
    if (mr === hi) return hint === 'hi' || hint === 'mr' ? hint : 'mr';
    return mr > hi ? 'mr' : 'hi';
  }
  const words = new Set(text.toLowerCase().split(/[^a-z]+/));
  const mr = MR_ROMAN.filter((w) => words.has(w)).length;
  const hi = HI_ROMAN.filter((w) => words.has(w)).length;
  if (mr > hi) return 'mr';
  if (hi > mr) return 'hi';
  return mr > 0 && hint && hint !== 'en' ? hint : 'en';
}

// Replaces standalone number words with digits so "एक ते पाच किलो" parses as a range.
function numberWordsToDigits(text: string): string {
  return text
    .split(/(\s+)/)
    .map((tok) => {
      const n = NUMBER_WORDS[tok.toLowerCase()];
      return n === undefined ? tok : String(n);
    })
    .join('');
}

interface Hit { keyword: string; index: number }

function categoryHits(lower: string, cat: CategoryDef): Hit[] {
  const hits: Hit[] = [];
  for (const kw of cat.keywords) {
    const k = kw.toLowerCase();
    let idx: number;
    if (/^[a-z0-9 ]+$/.test(k)) {
      const m = new RegExp(`(^|[^a-z0-9])${k.trim().replace(/ /g, '\\s+')}(?:e?s)?(?![a-z0-9])`).exec(lower);
      idx = m ? m.index + (m[1]?.length ?? 0) : -1;
    } else {
      idx = lower.indexOf(k);
    }
    if (idx >= 0) hits.push({ keyword: kw.trim(), index: idx });
  }
  return hits;
}

function bestCategory(lower: string): { cat: CategoryDef; hits: Hit[]; score: number } | null {
  let best: { cat: CategoryDef; hits: Hit[]; score: number } | null = null;
  for (const cat of CATEGORIES) {
    const hits = categoryHits(lower, cat);
    if (hits.length === 0) continue;
    // Longer keywords are more specific ("pest control" beats "control").
    const score = hits.reduce((s, h) => s + 1 + h.keyword.length / 10, 0);
    if (!best || score > best.score) best = { cat, hits, score };
  }
  return best;
}

function extractQuantity(text: string, purpose: 'capability' | 'request'): Partial<Attributes> {
  for (const [pat, unit] of UNIT_PATTERNS) {
    const range = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:to|-|–|ते|से|te|se)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:${pat})`, 'i').exec(text);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (purpose === 'capability') return { quantity_min: Math.min(lo, hi), quantity_max: Math.max(lo, hi), unit };
      return { quantity: Math.max(lo, hi), unit };
    }
    const single = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${pat})`, 'i').exec(text);
    if (single) {
      const n = Number(single[1]);
      if (purpose === 'request') return { quantity: n, unit };
      const upTo = /up ?to|upto|maximum|max|पर्यंत|तक/i.test(text);
      const atLeast = /minimum|min\b|at least|किमान|कम से कम/i.test(text);
      if (upTo) return { quantity_max: n, unit };
      if (atLeast) return { quantity_min: n, unit };
      return { unit };
    }
  }
  return {};
}

// True when the text rejects egg or meat ("no egg", "नॉनव्हेज नको", "only veg").
export function saysVegByNegation(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /(?:\bno|\bnot|\bwithout|don'?t want|do not want)\s+(?:any\s+)?(?:non[- ]?veg|nonveg|chicken|mutton|meat|fish)|(?:नॉनव्हेज|नॉनवेज|मांसाहारी|चिकन|मटण|मटन)\s*(?:नको|नहीं|नाही|मत)/.test(lower) ||
    /(?:\bno|\bnot|\bwithout)\s+eggs?\b|egg\s?less|(?:अंडी|अंडा|अंडे)\s*(?:नको|नहीं|नाही)|बिना अंड/.test(lower) ||
    /only veg|pure veg|strictly veg|फक्त शाकाहारी|सिर्फ शाकाहारी|शुद्ध शाकाहारी/.test(lower)
  );
}

function extractDiet(lower: string): Attributes['diet'] | undefined {
  if (/\bjain\b|जैन/.test(lower)) return 'jain';
  if (saysVegByNegation(lower)) return 'veg';
  if (/non[- ]?veg|nonveg|chicken|mutton|fish|prawn|चिकन|मटण|मटन|मासे|मछली|मांसाहारी/.test(lower)) return 'nonveg';
  if (/\begg\b|अंडा|अंडी|अंडे/.test(lower)) return 'egg';
  if (/\bveg\b|vegetarian|शाकाहारी/.test(lower)) return 'veg';
  return undefined;
}

function extractDelivery(lower: string): boolean | undefined {
  if (/no delivery|pickup only|pick up only|self pickup|डिलिव्हरी नाही|डिलीवरी नहीं/.test(lower)) return false;
  if (/deliver|डिलिव्हरी|डिलीवरी|घरपोच|home delivery/.test(lower)) return true;
  return undefined;
}

function extractPrice(text: string): Partial<Attributes> {
  const m =
    /(?:₹|rs\.?|inr|रु\.?|रुपये|rupees|rupaye|rupay)\s*(\d{2,7})/i.exec(text) ?? /(\d{2,7})\s*(?:₹|rs\.?|rupees|rupaye|rupay|रुपये|रुपए|रु\.?)/i.exec(text);
  if (!m) return {};
  const per = /per\s+(kg|hour|month|day|session|plate|person|class)|प्रति\s*(\S+)|दर\s*(\S+)/i.exec(text);
  return { price_amount: Number(m[1]), ...(per ? { price_per: (per[1] ?? per[2] ?? per[3])!.toLowerCase() } : {}) };
}

function extractNotice(text: string): number | undefined {
  const hrs = /(\d+)\s*(?:hours?|hrs?|तास|घंटे)\s*(?:notice|advance|before|आधी|पहले|अगोदर)/i.exec(text);
  if (hrs) return Number(hrs[1]);
  const days = /(\d+)\s*(?:days?|दिवस|दिन)\s*(?:notice|advance|before|आधी|पहले|अगोदर)/i.exec(text);
  if (days) return Number(days[1]) * 24;
  return undefined;
}

function extractTeaching(text: string): Partial<Attributes> {
  const out: Partial<Attributes> = {};
  const subjects = SUBJECTS.filter(([re]) => re.test(text)).map(([, s]) => s);
  if (subjects.length) out.subject = subjects.slice(0, 3).join(', ');
  const grade =
    /(?:class|std|standard|grade|इयत्ता|कक्षा)\s*(\d{1,2})/i.exec(text) ?? /(\d{1,2})\s*(?:th|वी|वीं|st|nd|rd)\b/i.exec(text);
  if (grade && Number(grade[1]) <= 12) out.grade = `class ${grade[1]}`;
  if (/online|ऑनलाइन|ऑनलाईन|video call|zoom/i.test(text)) out.mode = 'online';
  else if (/home tuition|at (your|my) home|घरी येऊन|घर आकर|घरी/i.test(text)) out.mode = 'in_person';
  return out;
}

const IST_OFFSET_MIN = 330;

// Reads "today 8 pm", "आज रात्री ८ वाजेपर्यंत", "kal subah 10 baje" as an IST deadline.
export function extractDeadline(text: string, now = new Date()): Date | null {
  const lower = text.toLowerCase();
  const tomorrow = /tomorrow|उद्या|\budya\b|कल(?![ाकी])|\bkal\b/.test(lower);
  const today = /today|tonight|आज|\baaj\b/.test(lower);
  const clock =
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i.exec(lower) ??
    /(\d{1,2})(?::(\d{2}))?\s*(?:वाजेपर्यंत|वाजता|वाजे|बजे तक|बजे|baje|vajta|vaje|o'?clock)/i.exec(lower);
  if (!clock && !tomorrow && !today) return null;

  let hour = clock ? Number(clock[1]) : 21;
  const minute = clock?.[2] ? Number(clock[2]) : 0;
  if (hour > 23 || minute > 59) return null;
  const marker = clock?.[3]?.replace(/\./g, '');
  const evening = /night|evening|tonight|रात्री|रात|संध्याकाळी|सायंकाळी|शाम|\braat\b|\bsham\b/.test(lower);
  const afternoon = /afternoon|दुपारी|दोपहर/.test(lower);
  const morning = /morning|सकाळी|सुबह|\bsubah\b|\bsakali\b/.test(lower);
  if (marker === 'pm' && hour < 12) hour += 12;
  else if (marker === 'am' && hour === 12) hour = 0;
  else if (!marker && hour < 12) {
    if (evening || (afternoon && hour < 7)) hour += 12;
    else if (!morning && hour < 8) hour += 12; // a bare "by 6" almost always means evening
  }

  // Work in IST wall-clock, then convert back to UTC.
  const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const target = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), hour, minute));
  if (tomorrow) target.setUTCDate(target.getUTCDate() + 1);
  let utc = new Date(target.getTime() - IST_OFFSET_MIN * 60_000);
  if (!tomorrow && utc.getTime() <= now.getTime()) {
    if (today) return null; // "today 8pm" said at 9pm: ask rather than guess
    utc = new Date(utc.getTime() + 24 * 3600_000);
  }
  return utc;
}

function buildItem(original: string, lower: string, hits: Hit[]): { item: string; itemEn: string } | null {
  if (hits.length === 0) return null;
  // Keep at most three matched terms, in the order the user said them, dropping
  // terms contained in a longer match.
  const sorted = [...hits].sort((a, b) => b.keyword.length - a.keyword.length);
  const kept: Hit[] = [];
  for (const h of sorted) {
    if (kept.some((k) => h.index >= k.index && h.index < k.index + k.keyword.length)) continue;
    kept.push(h);
  }
  const ordered = kept.sort((a, b) => a.index - b.index).slice(0, 3);
  const item = ordered.map((h) => original.slice(h.index, h.index + h.keyword.length)).join(' ');
  const itemEn = ordered.map((h) => GLOSS[h.keyword] ?? h.keyword).join(' ');
  void lower;
  return { item, itemEn };
}

function describeEn(purpose: 'capability' | 'request', cat: CategoryDef, itemEn: string | null, a: Attributes, deadline: Date | null): string {
  const parts: string[] = [];
  const head = itemEn ?? cat.labels.en.toLowerCase();
  if (purpose === 'capability') parts.push(`Offers ${head} (${cat.labels.en})`);
  else parts.push(`Needs ${head} (${cat.labels.en})`);
  if (a.subject) parts.push(`subject: ${a.subject}`);
  if (a.grade) parts.push(a.grade);
  if (a.diet) parts.push(a.diet === 'nonveg' ? 'non-vegetarian' : a.diet);
  if (a.quantity !== undefined) parts.push(`${a.quantity} ${a.unit}`);
  if (a.quantity_min !== undefined && a.quantity_max !== undefined) parts.push(`orders from ${a.quantity_min} to ${a.quantity_max} ${a.unit}`);
  else if (a.quantity_max !== undefined) parts.push(`orders up to ${a.quantity_max} ${a.unit}`);
  else if (a.quantity_min !== undefined) parts.push(`orders from ${a.quantity_min} ${a.unit}`);
  if (a.delivery === true) parts.push(purpose === 'request' ? 'delivery requested' : 'delivers');
  if (a.delivery === false) parts.push('no delivery');
  if (a.mode) parts.push(a.mode.replace('_', ' '));
  if (a.notice_hours !== undefined) parts.push(`${a.notice_hours} hours notice`);
  if (a.price_amount !== undefined) parts.push(`Rs ${a.price_amount}${a.price_per ? ' per ' + a.price_per : ''}`);
  if (deadline) parts.push(`needed by ${deadline.toISOString()}`);
  return parts.join('; ');
}

function interpretSegment(segment: string, purpose: 'capability' | 'request', now: Date): InterpretedItem {
  const text = numberWordsToDigits(toAsciiDigits(segment));
  const lower = text.toLowerCase();
  const best = bestCategory(lower);
  const cat = best?.cat ?? CATEGORIES.find((c) => c.slug === 'other')!;
  const allowed = new Set(cat.attributes);
  const attrs: Attributes = {};

  const built = best ? buildItem(text, lower, best.hits) : null;
  if (built && allowed.has('item')) attrs.item = built.item;
  if (allowed.has('diet')) {
    const d = extractDiet(lower);
    if (d) attrs.diet = d;
  }
  if (allowed.has('quantity')) Object.assign(attrs, extractQuantity(text, purpose));
  if (allowed.has('delivery')) {
    const d = extractDelivery(lower);
    if (d !== undefined) attrs.delivery = d;
  }
  if (allowed.has('notice_hours') && purpose === 'capability') {
    const n = extractNotice(text);
    if (n !== undefined) attrs.notice_hours = n;
  }
  if (allowed.has('price')) Object.assign(attrs, extractPrice(text));
  if (allowed.has('subject') || allowed.has('grade') || allowed.has('mode')) {
    const t = extractTeaching(text);
    if (t.subject && allowed.has('subject')) attrs.subject = t.subject;
    if (t.grade && allowed.has('grade')) attrs.grade = t.grade;
    if (t.mode && allowed.has('mode')) attrs.mode = t.mode;
  }
  const deadline = purpose === 'request' ? extractDeadline(text, now) : null;

  return {
    categorySlug: cat.slug,
    canonicalEn: describeEn(purpose, cat, built?.itemEn ?? null, attrs, deadline),
    sourceSpan: segment.trim(),
    attributes: attrs,
    extra: {},
    deadlineAt: deadline ? deadline.toISOString() : null,
  };
}

// A provider often lists several unrelated skills in one breath. Split on list
// separators, then merge a fragment with no recognised skill into its neighbour.
function splitSkills(text: string): string[] {
  const parts = text
    .split(/\s*(?:[;\n।|]|\.\s+|\.$|,\s+|\s+and also\s+|\s+and\s+|\s+also\s+|\s+plus\s+|\s+आणि\s+|\s+तसेच\s+|\s+और\s+|\s+aur\s+|\s+ani\s+)\s*/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 1);
  const merged: string[] = [];
  for (const part of parts) {
    const recognised = bestCategory(numberWordsToDigits(toAsciiDigits(part)).toLowerCase());
    if (!recognised && merged.length > 0) merged[merged.length - 1] += ' ' + part;
    else merged.push(part);
  }
  // Fragments in the same category are one skill described in pieces, even when
  // another skill is mentioned in between ("plumber and electrician, wiring and tap repair").
  const bySlug = new Map<string, string>();
  const out: string[] = [];
  for (const part of merged) {
    const slug = bestCategory(numberWordsToDigits(toAsciiDigits(part)).toLowerCase())?.cat.slug;
    if (!slug) {
      out.push(part);
      continue;
    }
    bySlug.set(slug, bySlug.has(slug) ? `${bySlug.get(slug)}, ${part}` : part);
  }
  return [...bySlug.values(), ...out];
}

export function interpretWithRules(
  input: { purpose: 'capability' | 'request'; text: string; localeHint?: Locale },
  now = new Date(),
): InterpretOutput {
  const text = input.text.trim();
  const locale = detectLocale(text, input.localeHint);
  const segments = input.purpose === 'capability' ? splitSkills(text) : [text];
  const items = (segments.length ? segments : [text]).map((s) => interpretSegment(s, input.purpose, now)).slice(0, 8);
  // One skill: keep the person's exact words rather than the re-joined fragments.
  if (items.length === 1) items[0]!.sourceSpan = text;

  let clarification: string | null = null;
  const unknown = items.every((i) => i.categorySlug === 'other');
  if (unknown && text.split(/\s+/).length < 3) clarification = 'too_short';
  else if (input.purpose === 'request' && /today|tonight|आज|\baaj\b/i.test(text) && items[0]?.deadlineAt === null && /\d/.test(toAsciiDigits(text)) && extractDeadline(numberWordsToDigits(toAsciiDigits(text)), now) === null && /(am|pm|वाजे|वाजता|बजे|baje|vaje)/i.test(text)) {
    clarification = 'deadline_passed';
  }
  return { locale, items, clarification, provider: 'rules', modelId: 'rules-v1', promptVersion: 'rules-v1', usage: {}, estCostUsd: 0 };
}
