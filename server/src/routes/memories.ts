import { Hono } from 'hono';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { getDb } from '../db/schema';
import { cosineSimilarity, embeddingToBuffer, bufferToEmbedding } from '../services/embed';
import { broadcast } from '../ws';

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
  const ch = crypto.createHash('sha256').update(body.content).digest('hex');
  const tags = JSON.stringify(body.tags || []);
  const src = body.source || 'manual';
  const scp = body.scope || 'project';
  const pn = body.project_name || null;
  let eb: Buffer | null = null;
  if (body.embedding && Array.isArray(body.embedding)) eb = embeddingToBuffer(new Float32Array(body.embedding));

  const db = getDb();
  db.prepare('INSERT INTO memories (id, content, content_hash, tags, source, scope, project_name, embedding) VALUES (?,?,?,?,?,?,?,?)').run(id, body.content, ch, tags, src, scp, pn, eb);
  broadcast('memory:created', { id, content: body.content, tags: body.tags, source: src, scope: scp, project_name: pn });
  return c.json({ id, content: body.content, tags: body.tags, source: src, scope: scp, project_name: pn }, 201);
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
    for (const w of words) { sql += ' AND content LIKE ?'; params.push(`%${w}%`); }
    sql += ' ORDER BY updated_at DESC LIMIT ?'; params.push(limit);
    return c.json({ results: (db.prepare(sql).all(...params) as any[]).map(r => ({ ...r, tags: JSON.parse(r.tags) })) });
  }

  let sql = 'SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories WHERE 1=1';
  const params: any[] = [];
  if (tags) { for (const t of tags.split(',').map(t => t.trim())) { sql += ' AND tags LIKE ?'; params.push(`%"${t}"%`); } }
  if (scope) { sql += ' AND scope = ?'; params.push(scope); }
  sql += ' ORDER BY updated_at DESC LIMIT ?'; params.push(limit);
  return c.json({ results: (db.prepare(sql).all(...params) as any[]).map(r => ({ ...r, tags: JSON.parse(r.tags) })) });
});

memories.post('/search', async (c) => {
  const body = await c.req.json<{ query: string; embedding?: number[]; tags?: string[]; scope?: string; limit?: number }>();
  if (!body.query) return c.json({ error: 'query is required' }, 400);
  const db = getDb();
  const limit = Math.min(body.limit || 10, 50);

  if (body.embedding && body.embedding.length > 0) {
    const qe = new Float32Array(body.embedding);
    const rows = db.prepare('SELECT id, content, content_hash, tags, source, scope, project_name, embedding, created_at, updated_at FROM memories ORDER BY updated_at DESC LIMIT 100').all() as any[];
    const results = rows
      .filter((r: any) => r.embedding instanceof Buffer)
      .map((r: any) => ({ id: r.id, content: r.content, content_hash: r.content_hash, tags: JSON.parse(r.tags), source: r.source, scope: r.scope, project_name: r.project_name, created_at: r.created_at, updated_at: r.updated_at, score: cosineSimilarity(qe, bufferToEmbedding(r.embedding)) }))
      .filter(r => r.score > 0.3).sort((a, b) => b.score - a.score).slice(0, limit);
    return c.json({ results });
  }

  return c.json({ results: (db.prepare('SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories WHERE content LIKE ? ORDER BY updated_at DESC LIMIT ?').all(`%${body.query}%`, limit) as any[]).map(r => ({ ...r, tags: JSON.parse(r.tags) })) });
});

memories.get('/rag', async (c) => {
  const q = c.req.query('q') || c.req.query('query') || '';
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 30);
  const db = getDb();

  let rows: any[];
  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    let sql = 'SELECT content, tags, source, scope, project_name, created_at FROM memories WHERE 1=1';
    const params: any[] = [];
    for (const w of words) { sql += ' AND content LIKE ?'; params.push(`%${w}%`); }
    sql += ' ORDER BY updated_at DESC LIMIT ?'; params.push(limit);
    rows = db.prepare(sql).all(...params) as any[];
  } else {
    rows = db.prepare('SELECT content, tags, source, scope, project_name, created_at FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit) as any[];
  }

  const context = rows.map((r, i) => `[${i + 1}] (${r.scope || '?'}) ${r.tags ? JSON.parse(r.tags).join(', ') : ''}\n${r.content}`).join('\n\n');
  return c.json({
    count: rows.length,
    context,
    format: 'Plain text memory context for LLM injection. Each entry: [N] (scope) tags\\ncontent',
    instructions: 'Inject this context into your system prompt to give the AI relevant prior knowledge.',
  });
});

memories.get('/stats', async (c) => {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as any).count;
  const scopes = db.prepare('SELECT scope, COUNT(*) as count FROM memories GROUP BY scope').all();
  const tagRows = db.prepare('SELECT tags FROM memories').all() as any[];
  const allTags = new Set<string>();
  for (const r of tagRows) { try { const p = JSON.parse(r.tags); if (Array.isArray(p)) p.forEach(t => allTags.add(t)); } catch {} }
  return c.json({ total_memories: count, scopes, unique_tags: allTags.size });
});

memories.post('/import', async (c) => {
  const body = await c.req.json<{ memories: Array<{ content: string; tags?: string[]; source?: string; scope?: string; project_name?: string; embedding?: number[] | null }> }>();
  if (!body.memories) return c.json({ error: 'memories array required' }, 400);
  const db = getDb();
  const inserted: string[] = [];
  const tx = db.transaction(() => {
    const stmt = db.prepare('INSERT INTO memories (id, content, content_hash, tags, source, scope, project_name, embedding) VALUES (?,?,?,?,?,?,?,?)');
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
  }); tx();
  if (inserted.length > 0) broadcast('memory:imported', { count: inserted.length, ids: inserted });
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

memories.post('/merge', async (c) => {
  const body = await c.req.json<{ target_id: string; source_ids: string[]; merged_content?: string; reason?: string }>();
  if (!body.target_id || !body.source_ids?.length) return c.json({ error: 'target_id and source_ids required' }, 400);
  const db = getDb();
  const target = db.prepare('SELECT * FROM memories WHERE id = ?').get(body.target_id) as any;
  if (!target) return c.json({ error: 'Target memory not found' }, 404);

  const sources = body.source_ids.map(id => db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any).filter(Boolean);
  if (sources.length === 0) return c.json({ error: 'No valid source memories found' }, 404);

  const allTags = new Set<string>(JSON.parse(target.tags || '[]'));
  const mergedContent = body.merged_content || [target.content, ...sources.map((s: any) => s.content)].join('\n\n---\n');
  for (const s of sources) {
    for (const t of JSON.parse(s.tags || '[]')) allTags.add(t);
  }

  const tx = db.transaction(() => {
    const newHash = crypto.createHash('sha256').update(mergedContent).digest('hex');
    db.prepare('UPDATE memories SET content = ?, content_hash = ?, tags = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(mergedContent, newHash, JSON.stringify([...allTags]), body.target_id);
    for (const s of sources) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(s.id);
    }
    db.prepare('INSERT INTO groom_log (id, action, target_id, source_ids, reason, status) VALUES (?,?,?,?,?,?)')
      .run(uuid(), 'merge', body.target_id, JSON.stringify(body.source_ids), body.reason || 'AI merge', 'applied');
  }); tx();

  const updated = db.prepare('SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories WHERE id = ?').get(body.target_id) as any;
  broadcast('memory:merged', { target_id: body.target_id, source_ids: body.source_ids, merged_sources: sources.length, reason: body.reason });
  return c.json({ success: true, memory: { ...updated, tags: JSON.parse(updated.tags) }, merged_sources: sources.length });
});

memories.post('/reconcile', async (c) => {
  const body = await c.req.json<{ memory_id: string; corrected_content: string; tags?: string[]; reason?: string }>();
  if (!body.memory_id || !body.corrected_content) return c.json({ error: 'memory_id and corrected_content required' }, 400);
  const db = getDb();
  if (!db.prepare('SELECT id FROM memories WHERE id = ?').get(body.memory_id)) return c.json({ error: 'Not found' }, 404);

  const newHash = crypto.createHash('sha256').update(body.corrected_content).digest('hex');
  const tx = db.transaction(() => {
    db.prepare('UPDATE memories SET content = ?, content_hash = ?, tags = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(body.corrected_content, newHash, JSON.stringify(body.tags || []), body.memory_id);
    db.prepare('INSERT INTO groom_log (id, action, target_id, reason, status) VALUES (?,?,?,?,?)')
      .run(uuid(), 'reconcile', body.memory_id, body.reason || 'AI reconcile', 'applied');
  }); tx();

  broadcast('memory:reconciled', { memory_id: body.memory_id, reason: body.reason });
  return c.json({ success: true, memory_id: body.memory_id });
});

memories.post('/groom/submit', async (c) => {
  const body = await c.req.json<{
    actions: Array<{
      action: 'merge' | 'reconcile' | 'flag' | 'delete';
      target_id?: string;
      source_ids?: string[];
      content?: string;
      tags?: string[];
      reason: string;
    }>;
  }>();
  if (!body.actions?.length) return c.json({ error: 'actions array required' }, 400);
  const db = getDb();
  const submitted: string[] = [];
  const tx = db.transaction(() => {
    const stmt = db.prepare('INSERT INTO groom_log (id, action, target_id, source_ids, reason, status, metadata) VALUES (?,?,?,?,?,?,?)');
    for (const a of body.actions) {
      const id = uuid();
      stmt.run(id, a.action, a.target_id || null, a.source_ids ? JSON.stringify(a.source_ids) : null, a.reason, 'pending', a.content || null);
      submitted.push(id);
    }
  }); tx();
  return c.json({ submitted: submitted.length, ids: submitted });
});

memories.post('/groom/apply/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ merged_content?: string; corrected_content?: string; tags?: string[] }>().catch(() => ({}));
  const db = getDb();
  const log = db.prepare('SELECT * FROM groom_log WHERE id = ?').get(id) as any;
  if (!log) return c.json({ error: 'Groom action not found' }, 404);
  if (log.status !== 'pending') return c.json({ error: `Action already ${log.status}` }, 400);

  if (log.action === 'merge' && log.target_id && log.source_ids) {
    const sources = JSON.parse(log.source_ids).filter((sid: string) => db.prepare('SELECT id FROM memories WHERE id = ?').get(sid));
    if (sources.length === 0) return c.json({ error: 'No valid source memories' }, 404);
    const target = db.prepare('SELECT * FROM memories WHERE id = ?').get(log.target_id) as any;
    if (!target) return c.json({ error: 'Target gone' }, 404);
    const allTags = new Set<string>(JSON.parse(target.tags || '[]'));
    const contents = [target.content];
    for (const sid of sources) {
      const s = db.prepare('SELECT * FROM memories WHERE id = ?').get(sid) as any;
      if (s) { for (const t of JSON.parse(s.tags || '[]')) allTags.add(t); contents.push(s.content); db.prepare('DELETE FROM memories WHERE id = ?').run(sid); }
    }
    db.prepare('UPDATE memories SET content = ?, content_hash = ?, tags = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(body.merged_content || contents.join('\n\n---\n'), crypto.createHash('sha256').update(body.merged_content || contents.join('\n\n---\n')).digest('hex'), JSON.stringify([...allTags]), log.target_id);
  } else if (log.action === 'reconcile' && log.target_id) {
    if (!body.corrected_content) return c.json({ error: 'corrected_content required for reconcile' }, 400);
    db.prepare('UPDATE memories SET content = ?, content_hash = ?, tags = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(body.corrected_content, crypto.createHash('sha256').update(body.corrected_content).digest('hex'), JSON.stringify(body.tags || []), log.target_id);
  }

  db.prepare("UPDATE groom_log SET status = 'applied' WHERE id = ?").run(id);
  broadcast('groom:applied', { log_id: id, action: log.action, target_id: log.target_id });
  return c.json({ success: true, action: log.action });
});

memories.post('/groom/reject/:id', async (c) => {
  const db = getDb();
  db.prepare("UPDATE groom_log SET status = 'rejected' WHERE id = ?").run(c.req.param('id'));
  broadcast('groom:rejected', { log_id: c.req.param('id') });
  return c.json({ success: true });
});

memories.get('/groom/log', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const status = c.req.query('status');
  const db = getDb();
  let sql = 'SELECT * FROM groom_log';
  const params: any[] = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?'; params.push(limit);
  return c.json({ actions: (db.prepare(sql).all(...params) as any[]).map(r => ({ ...r, source_ids: r.source_ids ? JSON.parse(r.source_ids) : null })) });
});

memories.post('/groom/reset', async (c) => {
  const db = getDb();
  db.prepare("UPDATE groom_log SET status = 'pending' WHERE status IN ('applied', 'rejected')").run();
  return c.json({ success: true });
});

memories.get('/:id', async (c) => {
  const db = getDb();
  const row = db.prepare('SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories WHERE id = ?').get(c.req.param('id')) as any;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ...row, tags: JSON.parse(row.tags) });
});

memories.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ content?: string; tags?: string[]; scope?: string; project_name?: string }>();
  const db = getDb();
  if (!db.prepare('SELECT id FROM memories WHERE id = ?').get(id)) return c.json({ error: 'Not found' }, 404);
  const upd: string[] = []; const p: any[] = [];
  if (body.content !== undefined) { upd.push('content = ?, content_hash = ?'); p.push(body.content, crypto.createHash('sha256').update(body.content).digest('hex')); }
  if (body.tags !== undefined) { upd.push('tags = ?'); p.push(JSON.stringify(body.tags)); }
  if (body.scope !== undefined) { upd.push('scope = ?'); p.push(body.scope); }
  if (body.project_name !== undefined) { upd.push('project_name = ?'); p.push(body.project_name); }
  if (!upd.length) return c.json({ error: 'Nothing to update' }, 400);
  upd.push("updated_at = datetime('now')"); p.push(id);
  db.prepare(`UPDATE memories SET ${upd.join(', ')} WHERE id = ?`).run(...p);
  const row = db.prepare('SELECT id, content, content_hash, tags, source, scope, project_name, created_at, updated_at FROM memories WHERE id = ?').get(id) as any;
  broadcast('memory:updated', { id, changes: { content: body.content, tags: body.tags, scope: body.scope, project_name: body.project_name } });
  return c.json({ ...row, tags: JSON.parse(row.tags) });
});

memories.delete('/:id', async (c) => {
  const db = getDb();
  if (!db.prepare('SELECT id FROM memories WHERE id = ?').get(c.req.param('id'))) return c.json({ error: 'Not found' }, 404);
  db.prepare('DELETE FROM memories WHERE id = ?').run(c.req.param('id'));
  broadcast('memory:deleted', { id: c.req.param('id') });
  return c.json({ deleted: c.req.param('id') });
});

export { memories };
