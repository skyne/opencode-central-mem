import { CentralApiClient } from './api-client.js';
import { memoryClient } from './client.js';
import { CONFIG } from '../config.js';
import { log } from './logger.js';
import { getTags } from './tags.js';
import { GroomingService } from './grooming-service.js';

interface SyncQueueItem {
  memoryId: string;
  action: 'upload' | 'delete';
  retries: number;
}

class SyncManager {
  private api: CentralApiClient | null = null;
  private queue: SyncQueueItem[] = [];
  private processing = false;
  private syncTimer: Timer | null = null;
  private directory: string = '';
  private grooming: GroomingService | null = null;

  init(directory: string, baseUrl?: string, token?: string) {
    this.directory = directory;
    if (baseUrl && token) {
      this.api = new CentralApiClient(baseUrl, token, CONFIG.sync?.offline ?? false);
      log('Sync manager initialized', { url: baseUrl });
      this.startPeriodicSync();
      this.grooming = new GroomingService(this.api, directory);
      const groomInterval = CONFIG.sync?.groomIntervalMs || 3600000;
      this.grooming.start(groomInterval);
    }
  }

  private startPeriodicSync() {
    const interval = CONFIG.sync?.syncIntervalMs || 60000;
    this.syncTimer = setInterval(() => this.processQueue(), interval);
  }

  stop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.grooming) {
      this.grooming.stop();
      this.grooming = null;
    }
  }

  isConnected(): boolean {
    return this.api !== null;
  }

  queueUpload(memoryId: string) {
    if (!this.api) return;
    this.queue = this.queue.filter(q => q.memoryId !== memoryId);
    this.queue.push({ memoryId, action: 'upload', retries: 0 });
  }

  queueDelete(memoryId: string) {
    if (!this.api) return;
    this.queue = this.queue.filter(q => q.memoryId !== memoryId);
    this.queue.push({ memoryId, action: 'delete', retries: 0 });
  }

  async processQueue() {
    if (!this.api || this.processing || this.queue.length === 0) return;
    this.processing = true;

    const items = [...this.queue];
    this.queue = [];

    for (const item of items) {
      try {
        if (item.action === 'upload') {
          await this.pushMemory(item.memoryId);
        } else if (item.action === 'delete') {
          await this.pushDelete(item.memoryId);
        }
      } catch (error) {
        log('Sync queue item failed', { memoryId: item.memoryId, action: item.action, error: String(error) });
        if (item.retries < 3) {
          this.queue.push({ ...item, retries: item.retries + 1 });
        }
      }
    }

    this.processing = false;
  }

  private async pushMemory(memoryId: string) {
    if (!this.api) return;

    const memory = await this.getMemoryById(memoryId);
    if (!memory) return;

    const tags = getTags(this.directory);
    const metadata = memory.metadata ? JSON.parse(memory.metadata) : {};
    const centralId = metadata._centralId;

    let embeddingArray: number[] | undefined;
    if (memory.vector instanceof Buffer || memory.vector instanceof Uint8Array) {
      const buf = memory.vector instanceof Buffer ? memory.vector : Buffer.from(memory.vector);
      if (buf.length > 0) {
        const emb = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        embeddingArray = Array.from(emb);
      }
    }

    if (centralId) {
      const updated = await this.api.update(centralId, {
        content: memory.content,
        tags: memory.tags ? memory.tags.split(',').map((t: string) => t.trim()) : [],
      });
      if (updated) {
        log('Synced (update) memory to central', { localId: memoryId, centralId });
      }
    } else {
      const newCentralId = await this.api.create({
        content: memory.content,
        tags: memory.tags ? memory.tags.split(',').map((t: string) => t.trim()) : [],
        scope: 'project',
        project_name: tags.project.projectName,
        embedding: embeddingArray,
      });

      if (newCentralId) {
        const updatedMetadata = { ...metadata, _centralId: newCentralId, _syncStatus: 'synced' };
        await this.updateMemoryMetadata(memoryId, updatedMetadata);
        log('Synced (create) memory to central', { localId: memoryId, centralId: newCentralId });
      }
    }
  }

  private async pushDelete(memoryId: string) {
    if (!this.api) return;

    const memory = await this.getMemoryById(memoryId);
    if (!memory) return;

    const metadata = memory.metadata ? JSON.parse(memory.metadata) : {};
    const centralId = metadata._centralId;

    if (centralId) {
      await this.api.delete(centralId);
    }
  }

  async searchBoth(query: string, containerTag: string, scope: 'project' | 'all-projects' = 'project'): Promise<{ success: boolean; results: any[]; total: number; timing: number; error?: string }> {
    const localResults = await memoryClient.searchMemories(query, containerTag, scope);

    if (!this.api) {
      return localResults;
    }

    try {
      const centralResults = await this.api.search(query, undefined, CONFIG.maxMemories || 10);
      const centralHashes = new Set(centralResults.map(r => r.content_hash));

      interface MergedResult { id: string; memory: string; similarity: number; tags?: string[]; metadata?: any; source: string }
      const merged: MergedResult[] = centralResults.map(r => ({
        id: r.id,
        memory: r.content,
        similarity: 0.95,
        tags: r.tags,
        metadata: { _centralId: r.id, _syncStatus: 'synced' },
        source: 'central',
      }));

      if (localResults.success) {
        for (const r of localResults.results) {
          if (!centralHashes.has(r.memory)) {
            merged.push({
              ...r,
              source: 'local',
              similarity: r.similarity * 0.9,
            });
          }
        }
      }

      merged.sort((a, b) => b.similarity - a.similarity);

      return {
        success: true as const,
        results: merged.slice(0, CONFIG.maxMemories || 10),
        total: merged.length,
        timing: 0,
      };
    } catch {
      return localResults;
    }
  }

  private async getMemoryById(id: string): Promise<any> {
    const { connectionManager } = await import('./sqlite/connection-manager.js');
    const { shardManager } = await import('./sqlite/shard-manager.js');

    const allShards = [
      ...shardManager.getAllShards('user', ''),
      ...shardManager.getAllShards('project', ''),
    ];

    for (const shard of allShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
      if (row) return row;
    }
    return null;
  }

  private async updateMemoryMetadata(id: string, metadata: Record<string, unknown>) {
    const { connectionManager } = await import('./sqlite/connection-manager.js');
    const { shardManager } = await import('./sqlite/shard-manager.js');

    const allShards = [
      ...shardManager.getAllShards('user', ''),
      ...shardManager.getAllShards('project', ''),
    ];

    for (const shard of allShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const row = db.prepare('SELECT metadata FROM memories WHERE id = ?').get(id) as any;
      if (row) {
        const existingMetadata = row.metadata ? JSON.parse(row.metadata) : {};
        const merged = { ...existingMetadata, ...metadata };
        db.prepare('UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(merged), Date.now(), id);
        return;
      }
    }
  }

  async resolveConflict(localId: string, centralId: string, ctx: any) {
    if (!ctx) return;

    const local = await this.getMemoryById(localId);
    if (!local) return;

    if (!this.api) return;
    const central = await this.api.search(local.content, undefined, 1);
    if (!central || central.length === 0) return;

    const centralEntry = central[0]!;
    if (local.content === centralEntry.content) return;

    try {
      const { getV2Client, generateStructuredOutput } = await import('./ai/opencode-provider.js');
      const v2Client = getV2Client();
      if (!v2Client) return;

      const { z } = await import('zod');
      const schema = z.object({
        merged_content: z.string(),
        reasoning: z.string(),
      });

      const merged = await generateStructuredOutput({
        client: v2Client,
        providerID: CONFIG.opencodeProvider || 'opencode',
        modelID: CONFIG.opencodeModel || 'opencode/deepseek-v4-flash-free',
        systemPrompt: `You are a merge mediator for memory entries. Two versions of the same memory exist — one local, one on the central server. Merge them into a single coherent version that preserves all unique information from both.`,
        userPrompt: `## Local version\n${local.content}\n\n## Central version\n${centralEntry.content}\n\nMerge these two versions.`,
        schema,
      });

      const { memoryClient: mc } = await import('./client.js');
      await mc.addMemory(merged.merged_content, local.container_tag, {
        tags: local.tags ? local.tags.split(',') : [],
        sessionID: 'conflict-merge',
      });

      log('Conflict resolved via AI merge', { localId, centralId });
    } catch (error) {
      log('Conflict resolution failed', { error: String(error) });
    }
  }
}

export const syncManager = new SyncManager();
