import { Hono } from 'hono';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { getDb } from '../db/schema';
import { cosineSimilarity, embeddingToBuffer, bufferToEmbedding } from '../services/embed';

const memories = new Hono();

memories.post('/', async (c) => {
  const body = await c.req.json<{
    content: string;
    tags?: string[];
    source?: string;
    scope?: string;
    project_name?: string;
    embedding?: number[] | null;
  }>();

  if (!body.content) return c.json({ error: 'content is required' }, 400);

  const id = uuid();
  const contentHash = crypto.createHash('sha256').update(body.content).digest('hex');
  const tags = JSON.stringify(body.tags || []);
  const source = body.source || 'manual';
  const scope = body.scope || 'project';
  const projectName = body.project_name || null;

  let embBuf: Buffer | null = null;
  if (body.embedding && Array.isArray(body.embedding)) {
    embBuf = embeddingToBuffer(new Float32Array(body.embedding));
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO memories (id, content, content_hash, tags, source, scope, project_name, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, body.content, contentHash, tags, source, scope, projectName, embBuf);

  return c.json({ id, content: body.content, tags: body.tags, source, scope, project_name: projectName }, 201);
});

memories.get('/search', async (c) => {
  const q = c.req.query('q');
  const tags = c.req.query('tags');
  const scope = c.req.query('scope');
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 50);
  const db = getDb();

  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    let sql = 'SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories WHERE 1=1';
    const params: any[] = [];
    for (const w of words) {
      sql += ' AND content LIKE ?';
      params.push(`%${w}%`);
    }
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(limit);
    const likeRows = db.prepare(sql).all(...params) as any[];
    return c.json({ results: likeRows.map(r => ({ ...r, tags: JSON.parse(r.tags) })) });
  }

  let sql = 'SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories WHERE 1=1';
  const params: any[] = [];
  if (tags) {
    for (const tag of tags.split(',').map(t => t.trim())) {
      sql += ' AND tags LIKE ?';
      params.push(`%"${tag}"%`);
    }
  }
  if (scope) { sql += ' AND scope = ?'; params.push(scope); }
  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as any[];
  return c.json({ results: rows.map(r => ({ ...r, tags: JSON.parse(r.tags) })) });
});

memories.post('/search', async (c) => {
  const body = await c.req.json<{ query: string; embedding?: number[]; tags?: string[]; scope?: string; limit?: number }>();
  if (!body.query) return c.json({ error: 'query is required' }, 400);

  const db = getDb();
  const limit = Math.min(body.limit || 10, 50);

  if (body.embedding && Array.isArray(body.embedding) && body.embedding.length > 0) {
    const queryEmb = new Float32Array(body.embedding);
    const rows = db.prepare(
      'SELECT id, content, content_hash, tags, source, scope, project_name, embedding, created_at, updated_at FROM memories ORDER BY updated_at DESC LIMIT 100'
    ).all() as any[];

    const scored = rows
      .filter(r => r.embedding instanceof Buffer)
      .map(r => ({
        id: r.id,
        content: r.content,
        content_hash: r.content_hash,
        tags: JSON.parse(r.tags),
        source: r.source,
        scope: r.scope,
        project_name: r.project_name,
        created_at: r.created_at,
        updated_at: r.updated_at,
        score: cosineSimilarity(queryEmb, bufferToEmbedding(r.embedding)),
      }))
      .filter(r => r.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return c.json({ results: scored });
  }

  const likeSql = 'SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories WHERE content LIKE ? ORDER BY updated_at DESC LIMIT ?';
  const likeRows = db.prepare(likeSql).all(`%${body.query}%`, limit) as any[];
  return c.json({ results: likeRows.map(r => ({ ...r, tags: JSON.parse(r.tags) })) });
});

memories.get('/stats', async (c) => {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as any).count;
  const scopeCounts = db.prepare('SELECT scope, COUNT(*) as count FROM memories GROUP BY scope').all();
  const tagRows = db.prepare('SELECT tags FROM memories').all() as any[];
  const allTags = new Set<string>();
  for (const row of tagRows) {
    try { const p = JSON.parse(row.tags); if (Array.isArray(p)) p.forEach(t => allTags.add(t)); } catch {}
  }
  return c.json({ total_memories: count, scopes: scopeCounts, unique_tags: allTags.size });
});

memories.post('/import', async (c) => {
  const body = await c.req.json<{
    memories: Array<{
      content: string;
      tags?: string[];
      source?: string;
      scope?: string;
      project_name?: string;
      embedding?: number[] | null;
    }>;
  }>();
  if (!body.memories || !Array.isArray(body.memories)) {
    return c.json({ error: 'memories array is required' }, 400);
  }

  const db = getDb();
  const inserted: string[] = [];
  const tx = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO memories (id, content, content_hash, tags, source, scope, project_name, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const m of body.memories) {
      if (!m.content) continue;
      const id = uuid();
      const ch = crypto.createHash('sha256').update(m.content).digest('hex');
      if (db.prepare('SELECT id FROM memories WHERE content_hash = ?').get(ch)) continue;
      let eb: Buffer | null = null;
      if (m.embedding && Array.isArray(m.embedding)) eb = embeddingToBuffer(new Float32Array(m.embedding));
      stmt.run(id, m.content, ch, JSON.stringify(m.tags || []), m.source || 'import', m.scope || 'project', m.project_name || null, eb);
      inserted.push(id);
    }
  });
  tx();
  return c.json({ imported: inserted.length, ids: inserted }, 201);
});

memories.get('/export/:scope?', async (c) => {
  const scope = c.req.param('scope');
  const db = getDb();
  let sql = 'SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories';
  const params: any[] = [];
  if (scope) { sql += ' WHERE scope = ?'; params.push(scope); }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params) as any[];
  return c.json({ count: rows.length, memories: rows.map(r => ({ ...r, tags: JSON.parse(r.tags) })) });
});

memories.get('/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb();
  const row = db.prepare('SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories WHERE id = ?').get(id) as any;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ...row, tags: JSON.parse(row.tags) });
});

memories.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ content?: string; tags?: string[]; scope?: string; project_name?: string }>();
  const db = getDb();
  if (!db.prepare('SELECT id FROM memories WHERE id = ?').get(id)) return c.json({ error: 'Not found' }, 404);

  const upd: string[] = [];
  const p: any[] = [];
  if (body.content !== undefined) { upd.push('content = ?, content_hash = ?'); p.push(body.content, crypto.createHash('sha256').update(body.content).digest('hex')); }
  if (body.tags !== undefined) { upd.push('tags = ?'); p.push(JSON.stringify(body.tags)); }
  if (body.scope !== undefined) { upd.push('scope = ?'); p.push(body.scope); }
  if (body.project_name !== undefined) { upd.push('project_name = ?'); p.push(body.project_name); }
  if (upd.length === 0) return c.json({ error: 'Nothing to update' }, 400);
  upd.push("updated_at = datetime('now')");
  p.push(id);
  db.prepare(`UPDATE memories SET ${upd.join(', ')} WHERE id = ?`).run(...p);

  const row = db.prepare('SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories WHERE id = ?').get(id) as any;
  return c.json({ ...row, tags: JSON.parse(row.tags) });
});

memories.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb();
  if (!db.prepare('SELECT id FROM memories WHERE id = ?').get(id)) return c.json({ error: 'Not found' }, 404);
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return c.json({ deleted: id });
});

export { memories };
