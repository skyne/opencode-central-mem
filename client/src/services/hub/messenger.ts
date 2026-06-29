import { agentService } from "./agent-service.js";
import { log } from "../logger.js";

interface MessageOptions {
  to: string;
  type?: string;
  content: string;
  replyTo?: string;
}

interface SentMessage {
  messageId: string;
  to: string;
}

interface ReceivedMessage {
  messageId: string;
  from: string;
  fromName: string;
  type: string;
  content: string;
  replyTo: string | null;
}

class Messenger {
  private pendingCallbacks = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  private messageListeners: Array<(msg: ReceivedMessage) => void> = [];

  onMessage(listener: (msg: ReceivedMessage) => void) {
    this.messageListeners.push(listener);
  }

  offMessage(listener: (msg: ReceivedMessage) => void) {
    this.messageListeners = this.messageListeners.filter(l => l !== listener);
  }

  init() {
    agentService.on("message_sent", (event, payload) => {
      const pending = this.pendingCallbacks.get(payload.message_id);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(payload);
        this.pendingCallbacks.delete(payload.message_id);
      }
    });

    agentService.on("message_received", (event, payload: ReceivedMessage) => {
      log("Message received", { from: payload.fromName, type: payload.type });
      for (const listener of this.messageListeners) {
        try { listener(payload); } catch {}
      }
    });
  }

  async send(options: MessageOptions): Promise<SentMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Message send timeout"));
      }, 10000);

      const messageId = crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);

      this.pendingCallbacks.set(messageId, { resolve, reject, timeout: timer });

      agentService.sendRaw("message:send", {
        to: options.to,
        type: options.type || "message",
        content: options.content,
        reply_to: options.replyTo || null,
      });
    });
  }

  async sendAndWaitReply(
    to: string,
    content: string,
    timeoutMs = 60000
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Reply timeout"));
      }, timeoutMs);

      const listener = (msg: ReceivedMessage) => {
        clearTimeout(timer);
        this.offMessage(listener);
        resolve(msg.content);
      };

      this.onMessage(listener);

      this.send({ to, type: "question", content }).catch((err) => {
        clearTimeout(timer);
        this.offMessage(listener);
        reject(err);
      });
    });
  }

  reply(to: string, replyToId: string, content: string) {
    agentService.sendRaw("message:send", {
      to,
      type: "answer",
      content,
      reply_to: replyToId,
    });
  }

  broadcast(content: string) {
    agentService.sendRaw("message:send", {
      to: "*",
      type: "broadcast",
      content,
    });
  }

  async listAgents(filter?: { capabilities?: string[]; status?: string }): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Agent list timeout"));
      }, 10000);

      const handler = (event: string, payload: any) => {
        clearTimeout(timer);
        agentService.off("agent_list", handler);
        resolve(payload.agents || []);
      };

      agentService.on("agent_list", handler);
      agentService.sendRaw("agent:list", { filter: filter || {} });
    });
  }
}

export const messenger = new Messenger();
