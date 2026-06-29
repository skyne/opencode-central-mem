import { CONFIG } from '../config.js';
import { log } from './logger.js';
import { CentralApiClient } from './api-client.js';

interface GroomAction {
  action: 'merge' | 'reconcile' | 'flag' | 'delete';
  target_id?: string;
  source_ids?: string[];
  content?: string;
  tags?: string[];
  reason: string;
}

export class GroomingService {
  private api: CentralApiClient;
  private timer: Timer | null = null;
  private running = false;
  private directory: string;

  constructor(api: CentralApiClient, directory: string) {
    this.api = api;
    this.directory = directory;
  }

  start(intervalMs = 3600000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.run(), intervalMs);
    log('Grooming service started', { intervalMs });
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      log('Grooming run started');
      const actions = await this.analyze();
      if (actions.length > 0) {
        const result = await this.api.groomSubmit(actions);
        log('Grooming actions submitted', { count: result.length });
      } else {
        log('Grooming: no actions needed');
      }
    } catch (error) {
      log('Grooming run failed', { error: String(error) });
    } finally {
      this.running = false;
    }
  }

  private async analyze(): Promise<GroomAction[]> {
    const exportData = await this.getMemoriesForAnalysis();
    if (!exportData || exportData.length < 2) return [];

    const actions: GroomAction[] = [];
    const v2Client = await this.getV2Client();
    if (!v2Client) return [];

    const BATCH = 20;
    for (let i = 0; i < exportData.length; i += BATCH) {
      const batch = exportData.slice(i, i + BATCH);
      const prompt = this.buildAnalysisPrompt(batch);
      try {
        const result = await this.callAI(v2Client, prompt);
        if (result?.actions) actions.push(...result.actions);
      } catch (e) {
        log('Grooming batch analysis failed', { batch: i, error: String(e) });
      }
    }

    return actions;
  }

  private async getMemoriesForAnalysis(): Promise<any[]> {
    const { connectionManager } = await import('./sqlite/connection-manager.js');
    const { shardManager } = await import('./sqlite/shard-manager.js');
    const memories: any[] = [];
    for (const shard of [...shardManager.getAllShards('user', ''), ...shardManager.getAllShards('project', '')]) {
      const db = connectionManager.getConnection(shard.dbPath);
      const rows = db.prepare('SELECT id, content, tags, container_tag, created_at FROM memories ORDER BY created_at DESC LIMIT 200').all() as any[];
      memories.push(...rows);
    }
    memories.sort((a, b) => b.created_at - a.created_at);
    return memories.slice(0, 200);
  }

  private async getV2Client() {
    try {
      const { getV2Client } = await import('./ai/opencode-provider.js');
      return getV2Client();
    } catch { return null; }
  }

  private buildAnalysisPrompt(memories: any[]): string {
    return `You are a memory grooming AI. Analyze these memory entries and identify:

1. **Duplicates**: Entries that say the same thing (exact or near-duplicate). Suggest merging them.
2. **Contradictions**: Entries that directly contradict each other (e.g., "port is 3000" vs "port is 8080"). Flag them for reconciliation.
3. **Stale entries**: Information that is likely outdated (references to old versions, deprecated APIs). Flag them.
4. **Tag improvements**: Entries with missing or poor tags.

For each action, output:
- action: "merge" (merge source_ids into target_id), "reconcile" (replace target content), "flag" (just note it), or "delete"
- target_id
- source_ids (for merge)
- content (new content for reconcile)
- tags (updated tags)
- reason (why this action)

Memories:
${memories.map((m, i) => `[${i}] id=${m.id} tags=${m.tags || '[]'} created=${m.created_at}\n${(m.content || '').slice(0, 300)}`).join('\n\n')}

Return a JSON object with an "actions" array. If no actions needed, return {"actions": []}.`;
  }

  private async callAI(v2Client: any, prompt: string): Promise<{ actions: GroomAction[] } | null> {
    try {
      const { generateStructuredOutput } = await import('./ai/opencode-provider.js');
      const { z } = await import('zod');

      const actionSchema = z.object({
        action: z.enum(['merge', 'reconcile', 'flag', 'delete']),
        target_id: z.string().optional(),
        source_ids: z.array(z.string()).optional(),
        content: z.string().optional(),
        tags: z.array(z.string()).optional(),
        reason: z.string(),
      });

      const schema = z.object({ actions: z.array(actionSchema) });

      const result = await generateStructuredOutput({
        client: v2Client,
        providerID: CONFIG.opencodeProvider || 'opencode',
        modelID: CONFIG.opencodeModel || 'opencode/deepseek-v4-flash-free',
        systemPrompt: 'You analyze memory entries and produce structured grooming actions. Respond ONLY with valid JSON matching the schema.',
        userPrompt: prompt,
        schema,
      });

      return result as { actions: GroomAction[] };
    } catch (error) {
      log('AI call failed during grooming', { error: String(error) });
      return null;
    }
  }
}
