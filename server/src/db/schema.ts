import { Database } from 'bun:sqlite';
import path from 'path';
import { mkdirSync } from 'fs';

let db: Database | null = null;

export function getDb(dbPath?: string): Database {
  if (db) return db;
  const fp = dbPath || path.join(process.cwd(), 'data', 'memories.db');
  mkdirSync(path.dirname(fp), { recursive: true });
  db = new Database(fp);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      scope TEXT NOT NULL DEFAULT 'project',
      project_name TEXT,
      sync_status TEXT NOT NULL DEFAULT 'synced',
      embedding BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at)');
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
