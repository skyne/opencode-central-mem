import { agentService } from "./agent-service.js";
import { log } from "../logger.js";

interface AssignedTask {
  taskId: string;
  title: string;
  description: string;
  requiredCapabilities: string[];
  priority: number;
  createdBy: string;
  createdByName: string;
  context: string | null;
  sessionID?: string;
}

interface TaskResult {
  summary: string;
  artifacts?: string[];
  details?: string;
  [key: string]: unknown;
}

type TaskExecutor = (task: AssignedTask) => Promise<TaskResult>;

class TaskHandler {
  private executor: TaskExecutor | null = null;
  private currentTask: AssignedTask | null = null;

  setExecutor(executor: TaskExecutor) {
    this.executor = executor;
  }

  get isProcessing(): boolean {
    return this.currentTask !== null;
  }

  get current(): AssignedTask | null {
    return this.currentTask;
  }

  init() {
    agentService.registerTaskHandler("task:assigned", async (payload: any) => {
      const task: AssignedTask = {
        taskId: payload.task_id,
        title: payload.title,
        description: payload.description || "",
        requiredCapabilities: payload.required_capabilities || [],
        priority: payload.priority || 0,
        createdBy: payload.created_by,
        createdByName: payload.created_by_name || "unknown",
        context: payload.context || null,
      };

      this.currentTask = task;
      log("Task handler invoked", { title: task.title, from: task.createdByName });

      try {
        if (this.executor) {
          const result = await this.executor(task);
          return result;
        }

        return {
          summary: `Task '${task.title}' received but no executor configured. Marking as complete.`,
        };
      } finally {
        this.currentTask = null;
      }
    });
  }

  async executeWithAI(task: AssignedTask, executeAITask: (prompt: string) => Promise<string>): Promise<TaskResult> {
    const systemContext = task.context
      ? `\n\nContext from shared memory:\n${task.context}`
      : "";

    const prompt = `You have been delegated a task by another AI agent (${task.createdByName}).

Task title: ${task.title}
Task description: ${task.description || "(no description)"}
Required capabilities: ${(task.requiredCapabilities || []).join(", ") || "none specified"}${systemContext}

Please complete this task using the tools available to you. When you are done, provide:
1. A brief summary of what was accomplished
2. Any files or artifacts that were created/modified
3. Any important details or notes

Keep your response concise and action-oriented.`;

    const response = await executeAITask(prompt);

    return {
      summary: response,
      details: `Completed via AI delegation from ${task.createdByName}`,
    };
  }
}

export const taskHandler = new TaskHandler();
