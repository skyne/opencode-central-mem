import { Hono } from 'hono';
import { readFileSync } from 'fs';
import { authMiddleware } from './middleware/auth';
import { memories } from './routes/memories';
import { getDb } from './db/schema';
import { wsHandler, setWsServer } from './ws';

const app = new Hono();

app.use('/memories/*', authMiddleware);
app.route('/memories', memories);

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/', async (c) => {
  try {
    const html = readFileSync('./public/index.html', 'utf-8');
    return c.html(html);
  } catch {
    return c.text('Dashboard not found', 404);
  }
});

const port = parseInt(process.env.PORT || '3737');
console.log(`Central memory server starting on :${port}`);
getDb();

function isBun(): boolean {
  return typeof process.versions.bun === 'string';
}

async function start() {
  if (isBun()) {
    const { default: serve } = await import('./serve-bun');
    serve(app, port);
  } else {
    const { serve } = await import('@hono/node-server');
    const { WebSocketServer } = await import('ws');

    const server = serve({
      fetch: app.fetch,
      port,
    });

    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', wsHandler.open);
    wss.on('connection', (ws) => {
      ws.on('message', (data) => wsHandler.message(ws as any, data as any));
      ws.on('close', () => wsHandler.close(ws as any));
    });

    console.log(`Server running on :${port}, WebSocket at /ws`);
  }
}

start();
