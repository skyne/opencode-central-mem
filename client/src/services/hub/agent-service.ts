import type { Capability } from "./capability-declarer.js";
import { log } from "../logger.js";

type EventHandler = (event: string, payload: any) => void;

const RECONNECT_DELAY_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 25000;

class AgentService {
  private ws: WebSocket | null = null;
  private hubUrl: string = "";
  private agentName: string = "";
  private capabilities: Capability[] = [];
  private metadata: Record<string, any> = {};

  private connected = false;
  private registered = false;
  private agentId: string = "";

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  private pendingMessages: Array<{ event: string; payload: any }> = [];
  private eventHandlers = new Map<string, EventHandler[]>();

  private taskHandlers = new Map<string, (payload: any) => Promise<any>>();

  on(event: string, handler: EventHandler) {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  off(event: string, handler: EventHandler) {
    const handlers = this.eventHandlers.get(event) || [];
    this.eventHandlers.set(event, handlers.filter(h => h !== handler));
  }

  private emit(event: string, payload: any) {
    const handlers = this.eventHandlers.get(event) || [];
    for (const handler of handlers) {
      try { handler(event, payload); } catch {}
    }
  }

  get isConnected(): boolean {
    return this.connected && this.registered;
  }

  get id(): string {
    return this.agentId;
  }

  get name(): string {
    return this.agentName;
  }

  registerTaskHandler(type: string, handler: (payload: any) => Promise<any>) {
    this.taskHandlers.set(type, handler);
  }

  async connect(
    hubUrl: string,
    agentName: string,
    capabilities: Capability[],
    metadata: Record<string, any> = {}
  ): Promise<string> {
    this.hubUrl = hubUrl;
    this.agentName = agentName;
    this.capabilities = capabilities;
    this.metadata = metadata;
    this.shouldReconnect = true;

    return this.doConnect();
  }

  private doConnect(): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const url = this.hubUrl.startsWith("ws") ? this.hubUrl : `ws://${this.hubUrl}`;
        this.ws = new WebSocket(url);

        const timeout = setTimeout(() => {
          reject(new Error("WebSocket connection timeout"));
        }, 10000);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          log("Hub WS connected", { url });
          this.sendPendingMessages();
          this.doRegister();
          this.startHeartbeat();
        };

        this.ws.onmessage = (event: MessageEvent) => {
          try {
            const msg = JSON.parse(event.data as string);
            this.handleMessage(msg);
          } catch {}
        };

        this.ws.onclose = () => {
          this.connected = false;
          this.registered = false;
          this.stopHeartbeat();
          this.emit("disconnected", { agent_id: this.agentId });
          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket connection failed"));
        };

        const checkRegistered = () => {
          if (this.registered && this.agentId) {
            resolve(this.agentId);
          } else {
            setTimeout(checkRegistered, 100);
          }
        };
        setTimeout(checkRegistered, 200);
      } catch (err) {
        reject(err);
      }
    });
  }

  private doRegister() {
    this.sendRaw("agent:register", {
      name: this.agentName,
      capabilities: this.capabilities,
      metadata: this.metadata,
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.registered = false;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    log("Hub reconnecting...", { delay: RECONNECT_DELAY_MS });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch(() => {});
    }, RECONNECT_DELAY_MS);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendRaw("agent:heartbeat", {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendRaw(event: string, payload: any) {
    const msg = JSON.stringify({ event, payload });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      this.pendingMessages.push({ event, payload });
    }
  }

  private sendPendingMessages() {
    while (this.pendingMessages.length > 0) {
      const msg = this.pendingMessages.shift()!;
      this.sendRaw(msg.event, msg.payload);
    }
  }

  private handleMessage(msg: { event: string; payload: any }) {
    const { event, payload } = msg;

    switch (event) {
      case "agent:registered":
        this.connected = true;
        this.registered = true;
        this.agentId = payload.agent_id;
        this.emit("registered", payload);
        break;

      case "agent:heartbeat_ack":
        break;

      case "agent:online":
        this.emit("agent_online", payload);
        break;

      case "agent:offline":
        this.emit("agent_offline", payload);
        break;

      case "agent:presence":
        this.emit("presence", payload);
        break;

      case "agent:list_result":
        this.emit("agent_list", payload);
        break;

      case "task:assigned":
        this.handleTaskAssigned(payload);
        break;

      case "task:status":
        this.emit("task_status", payload);
        break;

      case "task:completed":
        this.emit("task_completed", payload);
        break;

      case "task:failed":
        this.emit("task_failed", payload);
        break;

      case "task:cancelled":
        this.emit("task_cancelled", payload);
        break;

      case "message:recv":
        this.emit("message_received", payload);
        break;

      case "message:sent":
        this.emit("message_sent", payload);
        break;

      case "error":
        log("Hub error", { error: payload.message });
        this.emit("error", payload);
        break;
    }
  }

  private async handleTaskAssigned(payload: any) {
    this.emit("task_assigned", payload);

    const handler = this.taskHandlers.get("task:assigned");
    if (handler) {
      try {
        log("Processing assigned task", { task_id: payload.task_id, title: payload.title });
        this.sendRaw("task:update", {
          task_id: payload.task_id,
          status: "in_progress",
          progress: 0,
          message: "Starting work on task",
        });

        const result = await handler(payload);

        this.sendRaw("task:complete", {
          task_id: payload.task_id,
          result,
        });

        log("Task completed", { task_id: payload.task_id });
      } catch (err: any) {
        log("Task failed", { task_id: payload.task_id, error: String(err) });
        this.sendRaw("task:failed", {
          task_id: payload.task_id,
          error: String(err),
        });
      }
    }
  }
}

export const agentService = new AgentService();
