import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);

let dbInstance: any = null;

function isBun(): boolean {
  return typeof process.versions.bun === 'string';
}

class BunSqliteWrapper {
  private db: any;
  constructor(path: string) {
    const { Database: BunDB } = req('bun:sqlite');
    this.db = new BunDB(path);
  }
  exec(sql: string) { this.db.run(sql); }
  run(sql: string, ...params: any[]) { return this.db.run(sql, ...params); }
  get(sql: string, ...params: any[]) { return this.db.query(sql).get(...params); }
  all(sql: string, ...params: any[]) { return this.db.query(sql).all(...params); }
  prepare(sql: string) { return this.db.prepare(sql); }
  transaction(fn: Function) { return this.db.transaction(fn); }
  close() { this.db.close(); }
}

class BetterSqlite3Wrapper {
  private db: any;
  constructor(path: string) {
    const BetterDB = req('better-sqlite3');
    this.db = new BetterDB(path);
    this.db.pragma('journal_mode = WAL');
  }
  exec(sql: string) { this.db.exec(sql); }
  run(sql: string, ...params: any[]) {
    if (params.length === 0) { this.db.exec(sql); return { changes: 0 }; }
    return this.db.prepare(sql).run(...params);
  }
  get(sql: string, ...params: any[]) { return this.db.prepare(sql).get(...params); }
  all(sql: string, ...params: any[]) { return this.db.prepare(sql).all(...params); }
  prepare(sql: string) { return this.db.prepare(sql); }
  transaction(fn: Function) { return this.db.transaction(fn); }
  close() { this.db.close(); }
}

export function createDatabase(path: string): any {
  if (isBun()) {
    return new BunSqliteWrapper(path);
  }
  return new BetterSqlite3Wrapper(path);
}

export function setInstance(db: any) {
  dbInstance = db;
}

export function getInstance(): any {
  return dbInstance;
}
