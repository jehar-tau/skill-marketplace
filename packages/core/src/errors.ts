export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}
export const notFound = (what = 'not_found') => new AppError(404, what);
export const forbidden = (code = 'forbidden') => new AppError(403, code);
export const badRequest = (code: string, message?: string) => new AppError(400, code, message);
export const conflict = (code: string, message?: string) => new AppError(409, code, message);
export const tooMany = (code = 'rate_limited') => new AppError(429, code);
