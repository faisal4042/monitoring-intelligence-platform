export class HttpError extends Error {
  /** `details` is optional structured context for the client (e.g. a syntax error position). */
  constructor(public statusCode: number, message: string, public code?: string, public details?: Record<string, unknown>) {
    super(message);
  }
}
export const badRequest = (m: string, c?: string) => new HttpError(400, m, c);
export const unauthorized = (m = 'غير مصرح') => new HttpError(401, m, 'UNAUTHORIZED');
export const forbidden = (m = 'لا تملك الصلاحية اللازمة') => new HttpError(403, m, 'FORBIDDEN');
export const notFound = (m = 'غير موجود') => new HttpError(404, m, 'NOT_FOUND');
export const conflict = (m: string) => new HttpError(409, m, 'CONFLICT');
