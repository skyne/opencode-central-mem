let wsServer: any = null;
let wss: any = null;

export function setWsServer(server: any) {
  wsServer = server;
}

export function setWss(wsServerInstance: any) {
  wss = wsServerInstance;
}

export function broadcast(event: string, payload: any) {
  const msg = JSON.stringify({ event, payload, ts: Date.now() });

  if (wsServer && typeof wsServer.publish === 'function') {
    wsServer.publish('memories', msg);
  }

  if (wss) {
    wss.clients.forEach((client: any) => {
      if (client.readyState === 1) {
        client.send(msg);
      }
    });
  }
}

function isBun(): boolean {
  return typeof process.versions.bun === 'string';
}

export const wsHandler = {
  open(ws: any) {
    const id = crypto.randomUUID();
    ws.data = { id, token: '', subscribedTags: [], subscribedScopes: [] };

    if (isBun()) {
      ws.subscribe('memories');
    }

    ws.send(JSON.stringify({ event: 'connected', payload: { client_id: id } }));
  },

  message(ws: any, raw: any) {
    try {
      const msg = JSON.parse(raw.toString());
      const d = ws.data;
      if (!d) return;

      switch (msg.event) {
        case 'auth':
          d.token = msg.payload?.token || '';
          break;
        case 'ping':
          ws.send(JSON.stringify({ event: 'pong' }));
          break;
        case 'subscribe':
          if (msg.payload?.tags) d.subscribedTags = [...new Set([...d.subscribedTags, ...msg.payload.tags])];
          if (msg.payload?.scopes) d.subscribedScopes = [...new Set([...d.subscribedScopes, ...msg.payload.scopes])];
          ws.send(JSON.stringify({ event: 'subscribed', payload: { tags: d.subscribedTags, scopes: d.subscribedScopes } }));
          break;
      }
    } catch {}
  },

  close(ws: any) {
    const id = ws.data?.id;
    if (id && wsServer && typeof wsServer.publish === 'function') {
      wsServer.publish('memories', JSON.stringify({ event: 'peer_offline', payload: { client_id: id }, ts: Date.now() }));
    }
  },
};
