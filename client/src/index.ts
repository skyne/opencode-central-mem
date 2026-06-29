import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin";

import { memoryClient } from "./services/client.js";
import { formatContextForPrompt } from "./services/context.js";
import { getTags } from "./services/tags.js";
import { stripPrivateContent, isFullyPrivate } from "./services/privacy.js";
import { performAutoCapture } from "./services/auto-capture.js";
import { performUserProfileLearning } from "./services/user-memory-learning.js";
import { userPromptManager } from "./services/user-prompt/user-prompt-manager.js";
import { startWebServer, WebServer } from "./services/web-server.js";
import { syncManager } from "./services/sync-manager.js";
import { agentService } from "./services/hub/agent-service.js";
import { messenger } from "./services/hub/messenger.js";
import { delegation } from "./services/hub/delegation.js";
import { taskHandler } from "./services/hub/task-handler.js";
import { detectCapabilities, mergeCapabilities } from "./services/hub/capability-declarer.js";

import { isConfigured, CONFIG, initConfig } from "./config.js";
import { log } from "./services/logger.js";
import type { MemoryType } from "./types/index.js";
import { getLanguageName } from "./services/language-detector.js";
import type { MemoryScope } from "./services/client.js";

export const OpenCodeMemPlugin: Plugin = async (ctx: PluginInput, options?: PluginOptions) => {
  const { directory } = ctx;
  initConfig(directory);
  const tags = getTags(directory);
  let webServer: WebServer | null = null;
  let idleTimeout: Timer | null = null;

  const pluginOpts = options as Record<string, any> | undefined;
  const syncUrl = pluginOpts?.sync?.url || CONFIG.sync?.url;
  const syncToken = pluginOpts?.sync?.token || CONFIG.sync?.token;
  if (syncUrl && syncToken) {
    syncManager.init(directory, syncUrl, syncToken);
  }

  const hubUrl = pluginOpts?.hub?.url || CONFIG.hub?.url;
  const hubToken = pluginOpts?.hub?.token || CONFIG.hub?.token;
  const hubEnabled = pluginOpts?.hub?.enabled ?? CONFIG.hub?.enabled ?? true;
  if (hubUrl && hubToken && hubEnabled) {
    const agentName = CONFIG.hub?.agentName || `agent-${process.env.USER || 'opencode'}-${Math.random().toString(36).slice(2, 6)}`;
    const detectedCaps = detectCapabilities(directory);
    const mergedCaps = mergeCapabilities(detectedCaps, CONFIG.hub?.capabilities);

    log("Hub connecting", { url: hubUrl, agentName, capabilities: mergedCaps.map(c => c.name) });

    agentService.connect(hubUrl, agentName, mergedCaps, {
      token: hubToken,
      version: "0.1.0",
      project: tags.project.projectName || directory.split('/').pop(),
    }).then((agentId) => {
      log("Hub connected", { agentId, agentName });
      messenger.init();
      delegation.init();
      taskHandler.init();

      taskHandler.setExecutor(async (task) => {
        const summary = `Task '${task.title}' received from ${task.createdByName}. Task queued for processing.`;
        log("Hub task received", { task_id: task.taskId, title: task.title, from: task.createdByName });
        return { summary, details: "Task acknowledged. The AI agent will process it when available." };
      });
    }).catch((err) => {
      log("Hub connection failed", { error: String(err) });
    });
  }

  if (!isConfigured()) {
  }

  const GLOBAL_PLUGIN_WARMUP_KEY = Symbol.for("opencode-mem.plugin.warmedup");

  if (!(globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] && isConfigured()) {
    // Fire-and-forget: warmup is slow (embedding model load + index rebuild).
    // Awaiting it here serializes opencode's plugin loader and starves the TUI,
    // which gave the symptom "opencode hangs ~70s then disconnects on startup".
    (async () => {
      try {
        await memoryClient.warmup();
        (globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] = true;
      } catch (error) {
        log("Plugin warmup failed", { error: String(error) });
      }
    })();
  }

  (async () => {
    try {
      const { setConnectedProviders, setV2Client, createV2Client } =
        await import("./services/ai/opencode-provider.js");
      setV2Client(createV2Client(ctx.serverUrl));
      const providerResult = await ctx.client.provider.list();
      if (providerResult.data?.connected) {
        setConnectedProviders(providerResult.data.connected);
      }
    } catch (error) {
      log("Failed to initialize opencode provider state", { error: String(error) });
    }
  })();

  if (CONFIG.webServerEnabled) {
    startWebServer({
      port: CONFIG.webServerPort,
      host: CONFIG.webServerHost,
      enabled: CONFIG.webServerEnabled,
    })
      .then((server) => {
        webServer = server;
        const url = webServer.getUrl();

        webServer.setOnTakeoverCallback(async () => {
          if (ctx.client?.tui) {
            ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Explorer",
                  message: "Took over web server ownership",
                  variant: "success",
                  duration: 3000,
                },
              })
              .catch(() => {});
          }
        });

        if (webServer.isServerOwner()) {
          if (ctx.client?.tui) {
            ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Explorer",
                  message: `Web UI started at ${url}`,
                  variant: "success",
                  duration: 5000,
                },
              })
              .catch(() => {});
          }
        } else {
          if (ctx.client?.tui) {
            ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Explorer",
                  message: `Web UI available at ${url}`,
                  variant: "info",
                  duration: 3000,
                },
              })
              .catch(() => {});
          }
        }
      })
      .catch((error) => {
        log("Web server failed to start", { error: String(error) });

        if (ctx.client?.tui) {
          ctx.client.tui
            .showToast({
              body: {
                title: "Memory Explorer Error",
                message: `Failed to start: ${String(error)}`,
                variant: "error",
                duration: 5000,
              },
            })
            .catch(() => {});
        }
      });
  }

  const cleanupPlugin = async () => {
    syncManager.stop();
    agentService.disconnect();
    if (webServer) await webServer.stop();
    if (memoryClient) memoryClient.close();
  };

  const shutdownHandler = async () => {
    try {
      await cleanupPlugin();
      process.exit(0);
    } catch (error) {
      log("Shutdown error", { error: String(error) });
      process.exit(1);
    }
  };

  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);
  process.on("exit", () => {
    if (webServer) webServer.stop().catch(() => {});
    if (memoryClient) memoryClient.close();
  });

  return {
    "chat.message": async (input, output) => {
      if (!isConfigured() || !CONFIG.chatMessage.enabled) return;

      try {
        const textParts = output.parts.filter(
          (p): p is Part & { type: "text"; text: string } => p.type === "text"
        );

        if (textParts.length === 0) return;
        const userMessage = textParts.map((p) => p.text).join("\n");
        if (!userMessage.trim()) return;

        userPromptManager.savePrompt(input.sessionID, output.message.id, directory, userMessage);

        const messagesResponse = await ctx.client.session.messages({
          path: { id: input.sessionID },
        });
        const messages = messagesResponse.data || [];

        const hasNonSyntheticUserMessages = messages.some(
          (m) =>
            m.info.role === "user" &&
            !m.parts.every((p) => p.type !== "text" || p.synthetic === true)
        );

        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
        const isAfterCompaction = lastMessage?.info?.summary === true;

        const shouldInject =
          CONFIG.chatMessage.injectOn === "always" ||
          !hasNonSyntheticUserMessages ||
          (isAfterCompaction &&
            messages.filter(
              (m) =>
                m.info.role === "user" &&
                !m.parts.every((p) => p.type !== "text" || p.synthetic === true)
            ).length === 1);

        if (!shouldInject) return;

        const listResult = await memoryClient.listMemories(
          tags.project.tag,
          CONFIG.chatMessage.maxMemories
        );

        let memories = listResult.success ? listResult.memories : [];

        if (CONFIG.chatMessage.excludeCurrentSession) {
          memories = memories.filter((m: any) => m.metadata?.sessionID !== input.sessionID);
        }

        if (CONFIG.chatMessage.maxAgeDays) {
          const cutoffDate = Date.now() - CONFIG.chatMessage.maxAgeDays * 86400000;
          memories = memories.filter((m: any) => new Date(m.createdAt).getTime() > cutoffDate);
        }

        if (memories.length === 0) return;

        const projectMemories = {
          results: memories.map((m: any) => ({
            similarity: 1.0,
            memory: m.summary,
          })),
          total: memories.length,
          timing: 0,
        };

        const userId = tags.user.userEmail || null;
        const memoryContext = formatContextForPrompt(userId, projectMemories);

        if (memoryContext) {
          const contextPart: Part = {
            id: `prt-memory-context-${Date.now()}`,
            sessionID: input.sessionID,
            messageID: output.message.id,
            type: "text",
            text: memoryContext,
            synthetic: true,
          } as any;
          output.parts.unshift(contextPart);
        }
      } catch (error) {
        log("chat.message: ERROR", { error: String(error) });
        if (ctx.client?.tui && CONFIG.showErrorToasts) {
          await ctx.client.tui
            .showToast({
              body: {
                title: "Memory System Error",
                message: String(error),
                variant: "error",
                duration: 5000,
              },
            })
            .catch(() => {});
        }
      }
    },

    tool: {
      memory: tool({
        description: `Manage and query project memory (MATCH USER LANGUAGE: ${getLanguageName(CONFIG.autoCaptureLanguage || "en")}). Use 'search' with technical keywords/tags, 'add' to store knowledge, 'profile' for preferences. Search/list scope: project or all-projects.`,
        args: {
          mode: tool.schema.enum(["add", "search", "profile", "list", "forget", "help"]).optional(),
          content: tool.schema.string().optional(),
          query: tool.schema.string().optional(),
          tags: tool.schema.string().optional(),
          type: tool.schema.string().optional(),
          memoryId: tool.schema.string().optional(),
          limit: tool.schema.number().optional(),
          scope: tool.schema.enum(["project", "all-projects"]).optional(),
        },
        async execute(
          args: {
            mode?: "add" | "search" | "profile" | "list" | "forget" | "help";
            content?: string;
            query?: string;
            tags?: string;
            type?: MemoryType;
            memoryId?: string;
            limit?: number;
            scope?: MemoryScope;
          },
          toolCtx: { sessionID: string }
        ) {
          if (!isConfigured()) {
            return JSON.stringify({
              success: false,
              error: "Memory system not configured properly.",
            });
          }

          const needsWarmup = !(await memoryClient.isReady());
          if (needsWarmup) {
            return JSON.stringify({ success: false, error: "Memory system is initializing." });
          }

          const mode = args.mode || "help";
          const langName = getLanguageName(CONFIG.autoCaptureLanguage || "en");

          try {
            switch (mode) {
              case "help":
                return JSON.stringify({
                  success: true,
                  message: "Memory System Usage Guide",
                  commands: [
                    {
                      command: "add",
                      description: `Store new memory (MATCH USER LANGUAGE: ${langName})`,
                      args: ["content", "type?", "tags?"],
                    },
                    {
                      command: "search",
                      description: `Search memories via keywords (MATCH USER LANGUAGE: ${langName})`,
                      args: ["query"],
                    },
                    {
                      command: "profile",
                      description:
                        "View user profile or save an explicit preference (provide content to write)",
                      args: ["content?"],
                    },
                    { command: "list", description: "List recent memories", args: ["limit?"] },
                    { command: "forget", description: "Remove memory", args: ["memoryId"] },
                  ],
                  tagGuidance: "Use technical keywords for search. Tags rank highest.",
                });

              case "add":
                if (!args.content)
                  return JSON.stringify({ success: false, error: "content required" });
                const sanitizedContent = stripPrivateContent(args.content);
                if (isFullyPrivate(args.content))
                  return JSON.stringify({ success: false, error: "Private content blocked" });
                const tagInfo = tags.project;
                const parsedTags = args.tags
                  ? args.tags.split(",").map((t) => t.trim().toLowerCase())
                  : undefined;
                const result = await memoryClient.addMemory(sanitizedContent, tagInfo.tag, {
                  type: args.type,
                  tags: parsedTags,
                  displayName: tagInfo.displayName,
                  userName: tagInfo.userName,
                  userEmail: tagInfo.userEmail,
                  projectPath: tagInfo.projectPath,
                  projectName: tagInfo.projectName,
                  gitRepoUrl: tagInfo.gitRepoUrl,
                });
                return JSON.stringify({
                  success: result.success,
                  message: `Memory added`,
                  id: result.id,
                  tags: parsedTags,
                });

              case "search":
                if (!args.query) return JSON.stringify({ success: false, error: "query required" });
                const searchRes = await memoryClient.searchMemories(
                  args.query,
                  tags.project.tag,
                  args.scope ?? CONFIG.memory.defaultScope
                );
                if (!searchRes.success)
                  return JSON.stringify({ success: false, error: searchRes.error });
                return formatSearchResults(args.query, searchRes, args.limit);

              case "profile": {
                if (args.query) {
                  return JSON.stringify({
                    success: false,
                    error:
                      "query is not valid for profile mode. Use content to write a preference or omit all args to read.",
                  });
                }

                const { userProfileManager } =
                  await import("./services/user-profile/user-profile-manager.js");

                const userId = tags.user.userEmail || "unknown";

                // --- WRITE: explicit preference ---
                if (args.content !== undefined) {
                  const trimmed = args.content.trim();
                  if (!trimmed) {
                    return JSON.stringify({ success: false, error: "content must not be blank" });
                  }

                  if (!tags.user.userEmail) {
                    return JSON.stringify({
                      success: false,
                      error:
                        "Cannot save profile preference because no user email could be resolved. Configure userEmailOverride or git user.email.",
                    });
                  }

                  const sanitizedContent = stripPrivateContent(trimmed);
                  const hasNonPrivateContent =
                    sanitizedContent.replace(/\[REDACTED\]/g, "").trim().length > 0;

                  if (isFullyPrivate(trimmed) || !hasNonPrivateContent) {
                    return JSON.stringify({ success: false, error: "Private content blocked" });
                  }

                  const newPreference = {
                    category: "explicit",
                    description: sanitizedContent,
                    confidence: 1.0,
                    evidence: ["manual-write"],
                    lastUpdated: Date.now(),
                  };

                  const existingProfile = userProfileManager.getActiveProfile(userId);

                  if (existingProfile) {
                    const existingData = JSON.parse(existingProfile.profileData);
                    const mergedData = userProfileManager.mergeProfileData(existingData, {
                      preferences: [newPreference],
                    });
                    userProfileManager.updateProfile(
                      existingProfile.id,
                      mergedData,
                      0,
                      `Explicit preference added: ${sanitizedContent.slice(0, 80)}`
                    );
                    return JSON.stringify({
                      success: true,
                      message: "Preference saved to profile",
                    });
                  } else {
                    userProfileManager.createProfile(
                      userId,
                      tags.user.displayName || userId,
                      tags.user.userName || userId,
                      tags.user.userEmail || userId,
                      { preferences: [newPreference], patterns: [], workflows: [] },
                      0
                    );
                    return JSON.stringify({
                      success: true,
                      message: "Profile created with preference",
                    });
                  }
                }

                // --- READ: no content provided ---
                const profile = userProfileManager.getActiveProfile(userId);
                if (!profile) return JSON.stringify({ success: true, profile: null });
                const pData = JSON.parse(profile.profileData);
                return JSON.stringify({
                  success: true,
                  profile: {
                    ...pData,
                    version: profile.version,
                    lastAnalyzed: profile.lastAnalyzedAt,
                  },
                });
              }

              case "list":
                const listRes = await memoryClient.listMemories(
                  tags.project.tag,
                  args.limit || 20,
                  args.scope ?? CONFIG.memory.defaultScope
                );
                if (!listRes.success)
                  return JSON.stringify({ success: false, error: listRes.error });
                return JSON.stringify({
                  success: true,
                  count: listRes.memories?.length,
                  memories: listRes.memories?.map((m: any) => ({
                    id: m.id,
                    content: m.summary,
                    createdAt: m.createdAt,
                  })),
                });

              case "forget":
                if (!args.memoryId)
                  return JSON.stringify({ success: false, error: "memoryId required" });
                const delRes = await memoryClient.deleteMemory(args.memoryId);
                return JSON.stringify({ success: delRes.success, message: `Memory removed` });

              default:
                return JSON.stringify({ success: false, error: `Unknown mode: ${mode}` });
            }
          } catch (error) {
            return JSON.stringify({ success: false, error: String(error) });
          }
        },
      }),

      list_agents: tool({
        description: "List available agents connected to the hub and their capabilities",
        args: {
          capability: tool.schema.string().optional().describe("Filter by capability name"),
        },
        async execute(args: { capability?: string }) {
          if (!agentService.isConnected) {
            return JSON.stringify({ success: false, error: "Hub not connected" });
          }
          try {
            const agents = await messenger.listAgents({
              capabilities: args.capability ? [args.capability] : undefined,
            });
            return JSON.stringify({
              success: true,
              agents: agents.map((a: any) => ({
                id: a.id,
                name: a.name,
                status: a.status,
                capabilities: a.capabilities?.map((c: any) => c.name) || [],
                active_tasks: a.active_tasks || 0,
              })),
            });
          } catch (error) {
            return JSON.stringify({ success: false, error: String(error) });
          }
        },
      }),

      delegate_task: tool({
        description: "Delegate a task to another agent or let the hub route it to the best match",
        args: {
          title: tool.schema.string().describe("Task title"),
          description: tool.schema.string().optional().describe("Detailed task description"),
          target_agent: tool.schema.string().optional().describe("Specific agent name to assign to"),
          required_capabilities: tool.schema.string().optional().describe("Comma-separated required capabilities (e.g. 'rust,testing')"),
        },
        async execute(args: { title: string; description?: string; target_agent?: string; required_capabilities?: string }) {
          if (!agentService.isConnected) {
            return JSON.stringify({ success: false, error: "Hub not connected" });
          }
          try {
            const result = await delegation.delegate({
              title: args.title,
              description: args.description,
              targetAgent: args.target_agent,
              requiredCapabilities: args.required_capabilities?.split(",").map(c => c.trim()).filter(Boolean),
            });
            return JSON.stringify({
              success: true,
              task_id: result.taskId,
              status: result.status,
              assigned_to: result.assignedTo || null,
              message: result.assignedTo
                ? `Task assigned to agent`
                : "No agent currently available. Task queued.",
            });
          } catch (error) {
            return JSON.stringify({ success: false, error: String(error) });
          }
        },
      }),

      ask_agent: tool({
        description: "Ask a direct question to another agent and wait for a reply",
        args: {
          agent: tool.schema.string().describe("Target agent name"),
          question: tool.schema.string().describe("Your question"),
        },
        async execute(args: { agent: string; question: string }) {
          if (!agentService.isConnected) {
            return JSON.stringify({ success: false, error: "Hub not connected" });
          }
          try {
            const reply = await messenger.sendAndWaitReply(args.agent, args.question);
            return JSON.stringify({ success: true, reply, from: args.agent });
          } catch (error) {
            return JSON.stringify({ success: false, error: String(error) });
          }
        },
      }),

      get_task_status: tool({
        description: "Check the status of a previously delegated task",
        args: {
          task_id: tool.schema.string().describe("Task ID to check"),
        },
        async execute(args: { task_id: string }) {
          if (!agentService.isConnected) {
            return JSON.stringify({ success: false, error: "Hub not connected" });
          }
          try {
            const tasks = await delegation.listTasks({ createdBy: agentService.id });
            const task = tasks.find((t: any) => t.id === args.task_id);
            if (!task) {
              return JSON.stringify({ success: false, error: "Task not found" });
            }
            return JSON.stringify({
              success: true,
              task: {
                id: task.id,
                title: task.title,
                status: task.status,
                assigned_to: task.assigned_to,
                progress: task.progress,
                result: task.result ? JSON.parse(task.result) : null,
                error: task.error,
                created_at: task.created_at,
                completed_at: task.completed_at,
              },
            });
          } catch (error) {
            return JSON.stringify({ success: false, error: String(error) });
          }
        },
      }),

      cancel_task: tool({
        description: "Cancel a task you previously delegated",
        args: {
          task_id: tool.schema.string().describe("Task ID to cancel"),
        },
        async execute(args: { task_id: string }) {
          if (!agentService.isConnected) {
            return JSON.stringify({ success: false, error: "Hub not connected" });
          }
          try {
            await delegation.cancelTask(args.task_id);
            return JSON.stringify({ success: true, message: "Task cancelled" });
          } catch (error) {
            return JSON.stringify({ success: false, error: String(error) });
          }
        },
      }),
    },

    event: async (input: { event: { type: string; properties?: any } }) => {
      const event = input.event;
      if (event.type === "session.idle") {
        if (!isConfigured() || !CONFIG.autoCaptureEnabled) return;
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        if (idleTimeout) clearTimeout(idleTimeout);

        idleTimeout = setTimeout(async () => {
          try {
            await performAutoCapture(ctx, sessionID, directory);

            if (webServer?.isServerOwner()) {
              await performUserProfileLearning(ctx, directory);
              const { cleanupService } = await import("./services/cleanup-service.js");
              if (await cleanupService.shouldRunCleanup()) await cleanupService.runCleanup();
              const { connectionManager } = await import("./services/sqlite/connection-manager.js");
              connectionManager.checkpointAll();
            }
          } catch (error) {
            log("Idle processing error", { error: String(error) });
          } finally {
            idleTimeout = null;
          }
        }, 10000);
      }

      if (event.type === "session.compacted") {
        if (!isConfigured() || !CONFIG.compaction.enabled) return;

        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        try {
          const tags = getTags(directory);

          const memoriesResult = await memoryClient.searchMemoriesBySessionID(
            sessionID,
            tags.project.tag,
            CONFIG.compaction.memoryLimit
          );

          if (!memoriesResult.success || memoriesResult.results.length === 0) {
            return;
          }

          const memoryContext = formatMemoriesForCompaction(memoriesResult.results);

          await ctx.client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [{ id: `prt-compaction-${Date.now()}`, type: "text", text: memoryContext }],
              noReply: true,
            },
          });

          if (ctx.client?.tui) {
            await ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Restored",
                  message: `${memoriesResult.results.length} memories injected after compaction`,
                  variant: "success",
                  duration: 3000,
                },
              })
              .catch(() => {});
          }

          log("Compaction memory injected", {
            sessionID,
            count: memoriesResult.results.length,
          });
        } catch (error) {
          log("Compaction handler error", { error: String(error) });
        }
      }
    },
  };
};

function formatSearchResults(query: string, results: any, limit?: number): string {
  const memoryResults = results.results || [];
  return JSON.stringify({
    success: true,
    query,
    count: memoryResults.length,
    results: memoryResults.slice(0, limit || 10).map((r: any) => ({
      id: r.id,
      content: r.memory || r.chunk,
      similarity: Math.round(r.similarity * 100),
      source: r.source || 'local',
    })),
  });
}

function formatMemoriesForCompaction(memories: any[]): string {
  let output = `## Restored Session Memory\n\n`;

  memories.forEach((m, i) => {
    output += `### Memory ${i + 1}\n`;
    output += `${m.memory}\n\n`;
    if (m.tags && m.tags.length > 0) {
      output += `Tags: ${m.tags.join(", ")}\n\n`;
    }
  });

  return output;
}
