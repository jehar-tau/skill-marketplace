import { z } from 'zod';

// Typed, filterable attributes (spec §7.1). Anything the parser extracts outside
// this schema goes into `extra` and is used for text search only.

export const Diet = z.enum(['veg', 'nonveg', 'egg', 'jain']);
export type Diet = z.infer<typeof Diet>;

export const Unit = z.enum(['kg', 'g', 'plates', 'people', 'pieces', 'litres', 'hours', 'sessions']);
export type Unit = z.infer<typeof Unit>;

export const Mode = z.enum(['online', 'in_person', 'either']);

export const Attributes = z
  .object({
    item: z.string().max(120),
    diet: Diet,
    // A request states one quantity; a capability states the range it accepts.
    quantity: z.number().positive(),
    quantity_min: z.number().positive(),
    quantity_max: z.number().positive(),
    unit: Unit,
    delivery: z.boolean(),
    notice_hours: z.number().min(0).max(24 * 30),
    price_amount: z.number().positive(),
    price_per: z.string().max(40),
    subject: z.string().max(80),
    grade: z.string().max(40),
    mode: Mode,
  })
  .partial();
export type Attributes = z.infer<typeof Attributes>;

export interface ConstraintContext {
  // Hours between now and the request deadline, if it has one.
  hoursUntilDeadline?: number;
}

// Returns the reason a capability cannot serve a request, or null if it can.
// Only facts both sides stated are compared: a missing attribute never excludes.
export function attributeMismatch(
  request: Attributes,
  capability: Attributes,
  ctx: ConstraintContext = {},
): string | null {
  if (request.diet && capability.diet) {
    const ok: Record<Diet, Diet[]> = {
      veg: ['veg', 'jain'],
      jain: ['jain'],
      egg: ['egg', 'nonveg'],
      nonveg: ['nonveg'],
    };
    // A vegetarian request must never reach a non-veg-only capability, and the reverse.
    if (!ok[request.diet].includes(capability.diet)) return 'diet';
  }
  if (request.quantity !== undefined && request.unit && capability.unit && request.unit === capability.unit) {
    if (capability.quantity_min !== undefined && request.quantity < capability.quantity_min) return 'quantity_below_min';
    if (capability.quantity_max !== undefined && request.quantity > capability.quantity_max) return 'quantity_above_max';
  }
  if (request.delivery === true && capability.delivery === false) return 'delivery';
  if (
    capability.notice_hours !== undefined &&
    ctx.hoursUntilDeadline !== undefined &&
    ctx.hoursUntilDeadline < capability.notice_hours
  ) {
    return 'notice';
  }
  if (request.mode && capability.mode && request.mode !== 'either' && capability.mode !== 'either') {
    if (request.mode !== capability.mode) return 'mode';
  }
  return null;
}
