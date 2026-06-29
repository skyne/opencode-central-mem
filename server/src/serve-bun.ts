import { setWsServer } from './ws';

export default function serve(app: any, port: number) {
  const server = Bun.serve({
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws' && srv.upgrade(req)) return;
      return app.fetch(req);
    },
    websocket: {
      open: (ws) => { (ws as any)._handler = true; },
      message(ws, raw) {
        try {
          const msg = JSON.parse(raw.toString());
          const d = ws.data || {};
          switch (msg.event) {
            case 'auth': d.token = msg.payload?.token || ''; break;
            case 'ping': ws.send(JSON.stringify({ event: 'pong' })); break;
            case 'subscribe':
              if (msg.payload?.tags) d.subscribedTags = [...new Set([...(d.subscribedTags || []), ...msg.payload.tags])];
              if (msg.payload?.scopes) d.subscribedScopes = [...new Set([...(d.subscribedScopes || []), ...msg.payload.scopes])];
              ws.send(JSON.stringify({ event: 'subscribed', payload: { tags: d.subscribedTags || [], scopes: d.subscribedScopes || [] } }));
              break;
          }
        } catch {}
      },
      close() {},
    },
  });

  setWsServer(server);
  console.log(`Server running on :${port}, WebSocket at /ws (Bun native)`);
}
