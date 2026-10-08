import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}
export const idParams = z.object({id:z.string().uuid()}).strict();
export const expectedVersion = z.number().int().positive();
