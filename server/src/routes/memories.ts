import { Hono } from 'hono';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { getDb } from '../db/schema';
import { getEmbedding, cosineSimilarity, embeddingToBuffer, bufferToEmbedding } from '../services/embed';

const memories = new Hono();

memories.post('/', async (c) => {
  const body = await c.req.json<{
    content: string;
    tags?: string[];
    source?: string;
    scope?: string;
    project_name?: string;
  }>();

  if (!body.content) return c.json({ error: 'content is required' }, 400);

  const id = uuid();
  const contentHash = crypto.createHash('sha256').update(body.content).digest('hex');
  const tags = JSON.stringify(body.tags || []);
  const source = body.source || 'manual';
  const scope = body.scope || 'project';
  const projectName = body.project_name || null;

  const emb = await getEmbedding(body.content);
  const embBuf = embeddingToBuffer(emb);

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
    const queryEmb = await getEmbedding(q);
    const rows = db.prepare('SELECT id, content, content_hash, tags, source, scope, project_name, embedding, created_at, updated_at FROM memories ORDER BY updated_at DESC LIMIT ?').all(100) as any[];

    const scored = rows
      .map((row: any) => ({
        id: row.id,
        content: row.content,
        content_hash: row.content_hash,
        tags: JSON.parse(row.tags),
        source: row.source,
        scope: row.scope,
        project_name: row.project_name,
        created_at: row.created_at,
        updated_at: row.updated_at,
        score: row.embedding ? cosineSimilarity(queryEmb, bufferToEmbedding(row.embedding)) : 0,
      }))
      .filter(r => r.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return c.json({ results: scored });
  }

  let sql = 'SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories WHERE 1=1';
  const params: any[] = [];

  if (tags) {
    const tagList = tags.split(',').map(t => t.trim());
    for (const tag of tagList) {
      sql += ' AND tags LIKE ?';
      params.push(`%"${tag}"%`);
    }
  }
  if (scope) {
    sql += ' AND scope = ?';
    params.push(scope);
  }

  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as any[];
  const results = rows.map((row: any) => ({
    ...row,
    tags: JSON.parse(row.tags),
  }));

  return c.json({ results });
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

  const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const updates: string[] = [];
  const params: any[] = [];

  if (body.content !== undefined) {
    const emb = await getEmbedding(body.content);
    updates.push('content = ?, content_hash = ?, embedding = ?');
    params.push(body.content, crypto.createHash('sha256').update(body.content).digest('hex'), embeddingToBuffer(emb));
  }
  if (body.tags !== undefined) {
    updates.push('tags = ?');
    params.push(JSON.stringify(body.tags));
  }
  if (body.scope !== undefined) {
    updates.push('scope = ?');
    params.push(body.scope);
  }
  if (body.project_name !== undefined) {
    updates.push('project_name = ?');
    params.push(body.project_name);
  }

  if (updates.length === 0) return c.json({ error: 'Nothing to update' }, 400);

  updates.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE memories SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const row = db.prepare('SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories WHERE id = ?').get(id) as any;
  return c.json({ ...row, tags: JSON.parse(row.tags) });
});

memories.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb();
  const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Not found' }, 404);

  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return c.json({ deleted: id });
});

export { memories };
