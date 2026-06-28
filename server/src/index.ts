import { Hono } from 'hono';
import { authMiddleware } from './middleware/auth';
import { memories } from './routes/memories';
import { getDb } from './db/schema';

const app = new Hono();

app.use('/memories/*', authMiddleware);

app.route('/memories', memories);

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/', async (c) => {
  const html = Bun.file('./public/index.html');
  return new Response(html);
});

const port = parseInt(process.env.PORT || '3737');

console.log(`🚀 Central memory server starting on :${port}`);
getDb();

export default {
  port,
  fetch: app.fetch,
};
