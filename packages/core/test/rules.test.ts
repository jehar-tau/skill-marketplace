import { describe, expect, it } from 'vitest';
import { attributeMismatch } from '@sm/contracts';
import { confirmationText } from '../src/ai/confirm';
import { interpretWithRules } from '../src/ai/rules';

// 14:00 IST on 11 Oct 2026
const NOW = new Date('2026-10-11T08:30:00Z');

describe('rules interpreter', () => {
  it('keeps quantity, day and time from a Marathi request and invents nothing', () => {
    const out = interpretWithRules({ purpose: 'request', text: 'मला आज रात्री ८ वाजेपर्यंत १ किलो बिर्याणी पाहिजे' }, NOW);
    expect(out.locale).toBe('mr');
    const item = out.items[0]!;
    expect(item.categorySlug).toBe('food.prepared_meals');
    expect(item.attributes.quantity).toBe(1);
    expect(item.attributes.unit).toBe('kg');
    expect(item.deadlineAt).toBe('2026-10-11T14:30:00.000Z'); // 20:00 IST today
    expect(item.attributes.price_amount).toBeUndefined();
    expect(item.attributes.delivery).toBeUndefined();
    expect(item.attributes.diet).toBeUndefined();
  });

  it('reads a capability range from number words', () => {
    const out = interpretWithRules({ purpose: 'capability', text: 'मला घरगुती चिकन बिर्याणी बनवता येते. एक ते पाच किलोपर्यंत ऑर्डर घेऊ शकतो.' }, NOW);
    expect(out.items).toHaveLength(1);
    const a = out.items[0]!.attributes;
    expect(a.quantity_min).toBe(1);
    expect(a.quantity_max).toBe(5);
    expect(a.unit).toBe('kg');
    expect(a.diet).toBe('nonveg');
    expect(a.price_amount).toBeUndefined();
    expect(out.items[0]!.canonicalEn).toContain('chicken biryani');
  });

  it('splits three unrelated skills spoken in Marathi with English words', () => {
    const out = interpretWithRules({ purpose: 'capability', text: 'मी दहावीपर्यंत गणित शिकवते, घरगुती बिर्याणी बनवते आणि website पण बनवते' }, NOW);
    const slugs = out.items.map((i) => i.categorySlug).sort();
    expect(slugs).toEqual(['education.school_tutoring', 'food.prepared_meals', 'tech.web_development']);
  });

  it('handles Romanised and mixed input', () => {
    const mr = interpretWithRules({ purpose: 'request', text: 'mala udya 2 kg veg pulao pahije, home delivery' }, NOW);
    expect(mr.locale).toBe('mr');
    expect(mr.items[0]!.attributes).toMatchObject({ quantity: 2, unit: 'kg', diet: 'veg', delivery: true });
    expect(mr.items[0]!.deadlineAt).not.toBeNull();
    const hi = interpretWithRules({ purpose: 'request', text: 'kal 1 kg biryani delivery chahiye' }, NOW);
    expect(hi.locale).toBe('hi');
    expect(hi.items[0]!.attributes).toMatchObject({ quantity: 1, unit: 'kg', delivery: true });
  });

  it('does not treat a negated delivery as delivery', () => {
    const out = interpretWithRules({ purpose: 'capability', text: 'I make cakes, no delivery, pickup only' }, NOW);
    expect(out.items[0]!.attributes.delivery).toBe(false);
  });

  it('puts every critical fact in the native-language confirmation', () => {
    const out = interpretWithRules({ purpose: 'request', text: 'मला आज रात्री ८ वाजेपर्यंत १ किलो बिर्याणी पाहिजे' }, NOW);
    const i = out.items[0]!;
    const text = confirmationText('mr', 'request', i.categorySlug, i.attributes, i.deadlineAt);
    expect(text).toContain('1 किलो');
    expect(text).toContain('8:00 PM');
    expect(text).toContain('बरोबर?');
  });
});

describe('attribute constraints', () => {
  it('never lets a vegetarian request reach a non-veg capability', () => {
    expect(attributeMismatch({ diet: 'veg' }, { diet: 'nonveg' })).toBe('diet');
    expect(attributeMismatch({ diet: 'nonveg' }, { diet: 'veg' })).toBe('diet');
    expect(attributeMismatch({ diet: 'veg' }, { diet: 'veg' })).toBeNull();
    expect(attributeMismatch({ diet: 'veg' }, {})).toBeNull();
  });
  it('respects order size and notice period', () => {
    expect(attributeMismatch({ quantity: 8, unit: 'kg' }, { quantity_min: 1, quantity_max: 5, unit: 'kg' })).toBe('quantity_above_max');
    expect(attributeMismatch({ quantity: 3, unit: 'kg' }, { quantity_min: 1, quantity_max: 5, unit: 'kg' })).toBeNull();
    expect(attributeMismatch({}, { notice_hours: 24 }, { hoursUntilDeadline: 5 })).toBe('notice');
  });
});
