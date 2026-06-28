import { Context, Next } from 'hono';

const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token';

export async function authMiddleware(c: Context, next: Next) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token || token !== AUTH_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
}
