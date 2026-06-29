import { agentService } from "./agent-service.js";
import { log } from "../logger.js";

interface TaskOptions {
  title: string;
  description?: string;
  targetAgent?: string;
  requiredCapabilities?: string[];
  priority?: number;
  context?: string;
}

interface TaskResult {
  taskId: string;
  status: string;
  assignedTo: string | null;
  assignedToName?: string;
}

interface TaskStatusUpdate {
  taskId: string;
  status: string;
  progress: number;
  message: string | null;
  agentId: string;
  agentName: string;
}

interface TaskCompleted {
  taskId: string;
  result: any;
  agentId: string;
  agentName: string;
}

class Delegation {
  private pendingTasks = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  private taskStatusListeners = new Map<string, (update: TaskStatusUpdate) => void>();

  init() {
    agentService.on("task_assigned_to", (event, payload) => {
      log("Task assigned", { task_id: payload.task_id, to: payload.assigned_to_name });
    });

    agentService.on("task_status", (event, payload: TaskStatusUpdate) => {
      const listener = this.taskStatusListeners.get(payload.taskId);
      if (listener) listener(payload);
    });

    agentService.on("task_completed", (event, payload: TaskCompleted) => {
      const pending = this.pendingTasks.get(payload.taskId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(payload.result);
        this.pendingTasks.delete(payload.taskId);
      }
    });

    agentService.on("task_failed", (event, payload: any) => {
      const pending = this.pendingTasks.get(payload.taskId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(payload.error || "Task failed"));
        this.pendingTasks.delete(payload.taskId);
      }
    });

    agentService.on("task_cancelled", (event, payload: any) => {
      const pending = this.pendingTasks.get(payload.taskId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(payload.message || "Task cancelled"));
        this.pendingTasks.delete(payload.taskId);
      }
    });
  }

  async delegate(options: TaskOptions, timeoutMs = 300000): Promise<TaskResult> {
    return new Promise((resolve, reject) => {
      agentService.sendRaw("task:create", {
        title: options.title,
        description: options.description || "",
        target_agent: options.targetAgent,
        required_capabilities: options.requiredCapabilities || [],
        priority: options.priority || 0,
        context: options.context || null,
      });

      const timer = setTimeout(() => {
        reject(new Error("Task delegation timeout"));
      }, 10000);

      const createdHandler = (event: string, payload: any) => {
        if (payload.title === options.title) {
          clearTimeout(timer);
          agentService.off("task_created", createdHandler);

          resolve({
            taskId: payload.task_id,
            status: payload.status,
            assignedTo: payload.assigned_to,
          });
        }
      };
      agentService.on("task_created", createdHandler);
    });
  }

  async delegateAndWait(
    options: TaskOptions,
    timeoutMs = 300000
  ): Promise<any> {
    const taskResult = await this.delegate(options, timeoutMs);

    if (!taskResult.assignedTo) {
      return { status: "pending", message: "No agent available. Task queued." };
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTasks.delete(taskResult.taskId);
        reject(new Error(`Task '${options.title}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      agentService.sendRaw("task:update", {
        task_id: taskResult.taskId,
        status: "in_progress",
        progress: 0,
        message: "Task delegated, waiting for worker",
      });

      this.pendingTasks.set(taskResult.taskId, { resolve, reject, timeout: timer });
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    agentService.sendRaw("task:cancel", { task_id: taskId });
  }

  async listTasks(filter?: {
    status?: string;
    assignedTo?: string;
    createdBy?: string;
  }): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Task list timeout")), 10000);

      const params = new URLSearchParams();
      if (filter?.status) params.set("status", filter.status);
      if (filter?.assignedTo) params.set("assigned_to", filter.assignedTo);
      if (filter?.createdBy) params.set("created_by", filter.createdBy);

      const hubUrl = agentService["hubUrl"] || "localhost:3738";
      const httpUrl = hubUrl.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://");

      fetch(`http://${httpUrl}/tasks?${params}`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.json() as Promise<{ tasks: any[] }>)
        .then(data => {
          clearTimeout(timer);
          resolve(data.tasks || []);
        })
        .catch(err => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  onTaskStatus(taskId: string, listener: (update: TaskStatusUpdate) => void) {
    this.taskStatusListeners.set(taskId, listener);
  }

  offTaskStatus(taskId: string) {
    this.taskStatusListeners.delete(taskId);
  }
}

export const delegation = new Delegation();
