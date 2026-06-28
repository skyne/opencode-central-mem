export interface CentralMemory {
  id: string;
  content: string;
  content_hash: string;
  tags: string[];
  source: string;
  scope: string;
  project_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface SearchResponse {
  results: CentralMemory[];
}

export class CentralApiClient {
  private baseUrl: string;
  private token: string;
  private offline: boolean;

  constructor(baseUrl: string, token: string, offline = false) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.offline = offline;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`,
    };
  }

  async health(): Promise<boolean> {
    if (this.offline) return false;
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async search(query: string, embedding?: number[], limit = 10): Promise<CentralMemory[]> {
    if (this.offline) return [];
    try {
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      const res = await fetch(
        `${this.baseUrl}/memories/search?${params}`,
        { headers: this.headers, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return [];
      const data = (await res.json()) as SearchResponse;
      return data.results || [];
    } catch {
      return [];
    }
  }

  async create(memory: {
    content: string;
    tags?: string[];
    source?: string;
    scope?: string;
    project_name?: string;
    embedding?: number[];
  }): Promise<string | null> {
    if (this.offline) return null;
    try {
      const res = await fetch(`${this.baseUrl}/memories`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(memory),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { id: string };
      return data.id;
    } catch {
      return null;
    }
  }

  async update(id: string, updates: { content?: string; tags?: string[]; scope?: string; project_name?: string }): Promise<boolean> {
    if (this.offline) return false;
    try {
      const res = await fetch(`${this.baseUrl}/memories/${id}`, {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify(updates),
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async delete(id: string): Promise<boolean> {
    if (this.offline) return false;
    try {
      const res = await fetch(`${this.baseUrl}/memories/${id}`, {
        method: 'DELETE',
        headers: this.headers,
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async batchImport(memories: Array<{
    content: string;
    tags?: string[];
    source?: string;
    scope?: string;
    project_name?: string;
    embedding?: number[];
  }>): Promise<string[]> {
    if (this.offline) return [];
    try {
      const res = await fetch(`${this.baseUrl}/memories/import`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ memories }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { ids: string[] };
      return data.ids || [];
    } catch {
      return [];
    }
  }
}
