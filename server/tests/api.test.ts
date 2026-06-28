import { expect, test, describe, beforeAll, afterAll } from 'bun:test';

const BASE = 'http://localhost:3738';
const AUTH = 'test-token-for-tests';
let memoryId = '';
let serverProcess: any;

beforeAll(async () => {
  // Start server on a different port for tests
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts'], {
    env: { ...process.env, PORT: '3738', AUTH_TOKEN: AUTH },
    cwd: import.meta.dir + '/..',
  });
  serverProcess = proc;

  // Wait for server to be ready
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(500);
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
  }
  throw new Error('Server did not start');
});

afterAll(() => {
  if (serverProcess) serverProcess.kill();
});

describe('Health', () => {
  test('GET /health returns ok', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});

describe('Auth', () => {
  test('GET /memories without token returns 401', async () => {
    const res = await fetch(`${BASE}/memories`);
    expect(res.status).toBe(401);
  });

  test('GET /memories with wrong token returns 401', async () => {
    const res = await fetch(`${BASE}/memories`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  test('GET /memories with valid token works', async () => {
    const res = await fetch(`${BASE}/memories/search?limit=1`, {
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('CRUD', () => {
  test('POST /memories creates a memory', async () => {
    const res = await fetch(`${BASE}/memories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Test memory about bun and sqlite',
        tags: ['test', 'bun'],
        scope: 'project',
        project_name: 'test-project',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.content).toContain('bun');
    expect(body.tags).toContain('test');
    memoryId = body.id;
  });

  test('POST /memories with embedding sends vector search data', async () => {
    const emb = new Array(384).fill(0);
    emb[0] = 0.5;
    emb[1] = 0.3;
    const res = await fetch(`${BASE}/memories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Vector test memory',
        tags: ['vector'],
        scope: 'project',
        embedding: emb,
      }),
    });
    expect(res.status).toBe(201);
  });

  test('POST /memories without content returns 400', async () => {
    const res = await fetch(`${BASE}/memories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['test'], scope: 'project' }),
    });
    expect(res.status).toBe(400);
  });

  test('GET /memories/:id returns the memory', async () => {
    const res = await fetch(`${BASE}/memories/${memoryId}`, {
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(memoryId);
    expect(body.content).toBeDefined();
    expect(body.tags).toBeInstanceOf(Array);
  });

  test('GET /memories/:id with wrong id returns 404', async () => {
    const res = await fetch(`${BASE}/memories/nonexistent-id`, {
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    expect(res.status).toBe(404);
  });

  test('PUT /memories/:id updates tags', async () => {
    const res = await fetch(`${BASE}/memories/${memoryId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['test', 'bun', 'updated'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tags).toContain('updated');
  });

  test('DELETE /memories/:id deletes the memory', async () => {
    const res = await fetch(`${BASE}/memories/${memoryId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    expect(res.status).toBe(200);

    const getRes = await fetch(`${BASE}/memories/${memoryId}`, {
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    expect(getRes.status).toBe(404);
  });
});

describe('Search', () => {
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      await fetch(`${BASE}/memories`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `Searchable memory item number ${i} about testing and deployment`,
          tags: ['search', `item-${i}`],
          scope: 'project',
        }),
      });
    }
  });

  test('GET /memories/search finds by keyword', async () => {
    const res = await fetch(`${BASE}/memories/search?q=deployment+testing&limit=5`, {
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /memories/search with no query returns recent', async () => {
    const res = await fetch(`${BASE}/memories/search?limit=5`, {
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /memories/search filters by tags', async () => {
    const res = await fetch(`${BASE}/memories/search?tags=search&limit=5`, {
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    for (const r of body.results) {
      expect(r.tags).toContain('search');
    }
  });

  test('GET /memories/search filters by scope', async () => {
    const res = await fetch(`${BASE}/memories/search?scope=project&limit=5`, {
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const r of body.results) {
      expect(r.scope).toBe('project');
    }
  });

  test('POST /memories/search with embedding filters results', async () => {
    const emb = new Array(384).fill(0.01);
    emb[0] = 0.9;
    const res = await fetch(`${BASE}/memories/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test search', embedding: emb }),
    });
    expect(res.status).toBe(200);
  });
});

describe('Import/Export/Stats', () => {
  test('POST /memories/import batch inserts unique memories', async () => {
    const res = await fetch(`${BASE}/memories/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        memories: [
          { content: 'Import test A', tags: ['import-a'], scope: 'project' },
          { content: 'Import test B', tags: ['import-b'], scope: 'project' },
          { content: 'Import test A', tags: ['import-a'], scope: 'project' }, // duplicate
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.imported).toBe(2); // only 2 unique
    expect(body.ids.length).toBe(2);
  });

  test('GET /memories/stats returns correct counts', async () => {
    const res = await fetch(`${BASE}/memories/stats`, {
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total_memories).toBeGreaterThan(0);
    expect(body.unique_tags).toBeGreaterThan(0);
    expect(body.scopes).toBeInstanceOf(Array);
  });

  test('GET /memories/export returns all memories', async () => {
    const res = await fetch(`${BASE}/memories/export`, {
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.memories).toBeInstanceOf(Array);
  });

  test('GET /memories/export/project filters by scope', async () => {
    const res = await fetch(`${BASE}/memories/export/project`, {
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const m of body.memories) {
      expect(m.scope).toBe('project');
    }
  });
});
