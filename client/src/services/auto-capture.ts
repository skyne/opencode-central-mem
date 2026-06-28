import type { PluginInput } from "@opencode-ai/plugin";
import { memoryClient } from "./client.js";
import { getTags } from "./tags.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";

interface ToolCallInfo {
  name: string;
  input: string;
}

const MAX_TOOL_INPUT_LENGTH = 100;
const RETRY_BASE_DELAY_MS = 2000;

let isCaptureRunning = false;

export async function performAutoCapture(
  ctx: PluginInput,
  sessionID: string,
  directory: string
): Promise<void> {
  if (isCaptureRunning) return;
  isCaptureRunning = true;

  let claimedPromptId: string | null = null;
  const maxRetries = CONFIG.autoCaptureMaxRetries ?? 3;
  let attempt = 0;

  try {
    const prompt = userPromptManager.getLastUncapturedPrompt(sessionID);
    if (!prompt) {
      return;
    }

    if (!userPromptManager.claimPrompt(prompt.id)) {
      return;
    }
    claimedPromptId = prompt.id;
    attempt = prompt.capture_attempts || 0;

    while (attempt < maxRetries) {
      attempt++;
      try {
        if (!ctx.client) {
          throw new Error("Client not available");
        }

        const response = await ctx.client.session.messages({
          path: { id: sessionID },
        });

        if (!response.data) {
          return;
        }

        const messages = response.data;
        const promptIndex = messages.findIndex((m: any) => m.info?.id === prompt.messageId);
        if (promptIndex === -1) {
          return;
        }

        const aiMessages = messages.slice(promptIndex + 1);
        if (aiMessages.length === 0) {
          return;
        }

        const { textResponses, toolCalls } = extractAIContent(aiMessages);
        if (textResponses.length === 0 && toolCalls.length === 0) {
          return;
        }

        const tags = getTags(directory);
        const latestMemory = await getLatestProjectMemory(tags.project.tag);
        const context = buildMarkdownContext(
          prompt.content,
          textResponses,
          toolCalls,
          latestMemory
        );

        const summaryResult = await generateSummary(context, sessionID, prompt.content);

        if (!summaryResult || summaryResult.type === "skip") {
          userPromptManager.deletePrompt(prompt.id);
          claimedPromptId = null;
          return;
        }

        const summaryWithTags =
          summaryResult.tags && summaryResult.tags.length > 0
            ? `${summaryResult.summary}\n\nTags: ${summaryResult.tags.join(", ")}`
            : summaryResult.summary;

        const result = await memoryClient.addMemory(summaryWithTags, tags.project.tag, {
          source: "auto-capture" as any,
          type: summaryResult.type as any,
          tags: summaryResult.tags,
          sessionID,
          promptId: prompt.id,
          captureTimestamp: Date.now(),
          displayName: tags.project.displayName,
          userName: tags.project.userName,
          userEmail: tags.project.userEmail,
          projectPath: tags.project.projectPath,
          projectName: tags.project.projectName,
          gitRepoUrl: tags.project.gitRepoUrl,
          sync_to_central: summaryResult.sync_to_central || false,
        });

        if (result.success) {
          userPromptManager.linkMemoryToPrompt(prompt.id, result.id);
          userPromptManager.markAsCaptured(prompt.id);
          claimedPromptId = null;

          if (CONFIG.showAutoCaptureToasts) {
            await ctx.client?.tui
              .showToast({
                body: {
                  title: "Memory Captured",
                  message: "Project memory saved from conversation",
                  variant: "success",
                  duration: 3000,
                },
              })
              .catch(() => {});
          }
          return;
        } else {
          throw new Error(result.error || "Database persistence failed");
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);

        userPromptManager.recordFailedAttempt(prompt.id);

        if (attempt < maxRetries) {
          log(`Auto-capture warning (attempt ${attempt}/${maxRetries})`, { error: errMsg });
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1))
          );
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log(`Auto-capture final error after ${attempt} attempts`, { error: errMsg });
    if (CONFIG.showErrorToasts) {
      const shortReason = errMsg.length > 100 ? errMsg.substring(0, 100) + "..." : errMsg;
      await ctx.client?.tui
        .showToast({
          body: {
            title: "Auto Capture Failed",
            message: shortReason,
            variant: "error",
            duration: 5000,
          },
        })
        .catch(() => {});
    }
  } finally {
    if (claimedPromptId !== null) {
      try {
        userPromptManager.releaseClaim(claimedPromptId);
      } catch (releaseErr) {
        log(
          `Failed to release captured=2 claim for prompt ${claimedPromptId}: ${
            releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
          }`
        );
      }
    }
    isCaptureRunning = false;
  }
}

function extractAIContent(messages: any[]): {
  textResponses: string[];
  toolCalls: ToolCallInfo[];
} {
  const textResponses: string[] = [];
  const toolCalls: ToolCallInfo[] = [];

  for (const msg of messages) {
    if (msg.info?.role !== "assistant") continue;

    if (!msg.parts || !Array.isArray(msg.parts)) continue;

    const textParts = msg.parts.filter((p: any) => p.type === "text" && p.text);
    if (textParts.length > 0) {
      const text = textParts.map((p: any) => p.text).join("\n");
      if (text.trim()) {
        textResponses.push(text.trim());
      }
    }

    const toolParts = msg.parts.filter((p: any) => p.type === "tool");
    for (const tool of toolParts) {
      const name = tool.tool || "unknown";
      let input = "";

      if (tool.state?.input) {
        const inputObj = tool.state.input;
        if (typeof inputObj === "string") {
          input = inputObj;
        } else if (typeof inputObj === "object") {
          const params = [];
          for (const [key, value] of Object.entries(inputObj)) {
            params.push(`${key}: ${JSON.stringify(value)}`);
          }
          input = params.join(", ");
        }
      }

      if (input.length > MAX_TOOL_INPUT_LENGTH) {
        input = input.substring(0, MAX_TOOL_INPUT_LENGTH) + "...";
      }

      toolCalls.push({ name, input });
    }
  }

  return { textResponses, toolCalls };
}

async function getLatestProjectMemory(containerTag: string): Promise<string | null> {
  try {
    const result = await memoryClient.listMemories(containerTag, 1);
    if (!result.success || result.memories.length === 0) {
      return null;
    }

    const latest = result.memories[0];
    if (!latest) {
      return null;
    }

    const content = latest.summary;

    if (content.length <= 500) {
      return content;
    }

    return content.substring(0, 500) + "...";
  } catch {
    return null;
  }
}

function buildMarkdownContext(
  userPrompt: string,
  textResponses: string[],
  toolCalls: ToolCallInfo[],
  latestMemory: string | null
): string {
  const sections: string[] = [];

  if (latestMemory) {
    sections.push(`## Previous Memory Context`);
    sections.push(`---`);
    sections.push(latestMemory);
    sections.push(`---\n`);
  }

  sections.push(`## User Request`);
  sections.push(`---`);
  sections.push(userPrompt);
  sections.push(`---\n`);

  if (textResponses.length > 0) {
    sections.push(`## AI Response`);
    sections.push(`---`);
    sections.push(textResponses.join("\n\n"));
    sections.push(`---\n`);
  }

  if (toolCalls.length > 0) {
    sections.push(`## Tools Used`);
    sections.push(`---`);
    for (const tool of toolCalls) {
      if (tool.input) {
        sections.push(`- ${tool.name}(${tool.input})`);
      } else {
        sections.push(`- ${tool.name}`);
      }
    }
    sections.push(`---\n`);
  }

  return sections.join("\n");
}

async function generateSummary(
  context: string,
  sessionID: string,
  userPrompt: string
): Promise<{ summary: string; type: string; tags: string[]; sync_to_central?: boolean } | null> {
  const { detectLanguage, getLanguageName } = await import("./language-detector.js");
  const targetLang =
    CONFIG.autoCaptureLanguage === "auto" || !CONFIG.autoCaptureLanguage
      ? detectLanguage(userPrompt)
      : CONFIG.autoCaptureLanguage;
  const langName = getLanguageName(targetLang);

  const providerID = CONFIG.opencodeProvider || "opencode";
  const modelID = CONFIG.opencodeModel || "opencode/deepseek-v4-flash-free";
  const hasManualConfig = CONFIG.memoryModel && CONFIG.memoryApiUrl;

  // Prioritize opencode SDK path (works with free model, no external API key needed)
  const { getV2Client, generateStructuredOutput } = await import("./ai/opencode-provider.js");
  const v2Client = getV2Client();

  const syncInstr = CONFIG.sync?.url
    ? `\n\n7. Decide if this knowledge is worth syncing to the global memory store shared across all machines. Set sync_to_central=true if: cross-project useful, non-obvious, reusable patterns, architecture decisions, setup guides. Set sync_to_central=false if: project-specific, trivial, task-specific.`
    : `\n\n7. Set sync_to_central=false.`;

  if (v2Client) {
    const systemPrompt = `You are a technical memory recorder for a software development project.

RULES:
1. ONLY capture technical work (code, bugs, features, architecture, config)
2. SKIP non-technical by returning type="skip"
3. NO meta-commentary or behavior analysis
4. Include specific file names, functions, technical details
5. Generate 2-4 technical tags (e.g., "react", "auth", "bug-fix")
6. You MUST write the summary in ${langName}.${syncInstr}

FORMAT:
## Request
[1-2 sentences: what was requested, in ${langName}]

## Outcome
[1-2 sentences: what was done, include files/functions, in ${langName}]

SKIP if: greetings, casual chat, no code/decisions made
CAPTURE if: code changed, bug fixed, feature added, decision made`;

    const aiPrompt = `${context}

Analyze this conversation. If it contains technical work (code, bugs, features, decisions), create a concise summary and relevant tags. If it's non-technical (greetings, casual chat, incomplete requests), return type="skip" with empty summary.`;

    const { z } = await import("zod");
    const schema = z.object({
      summary: z.string(),
      type: z.string(),
      tags: z.array(z.string()),
      sync_to_central: z.boolean().optional(),
    });

    const result = await generateStructuredOutput({
      client: v2Client,
      providerID,
      modelID,
      systemPrompt,
      userPrompt: aiPrompt,
      schema,
    });

    return {
      summary: result.summary,
      type: result.type,
      tags: (result.tags || []).map((t: string) => t.toLowerCase().trim()),
      sync_to_central: result.sync_to_central || false,
    };
  }

  // Fallback: manual config path (only if opencode SDK not available)
  if (!hasManualConfig) {
    throw new Error("No AI provider available for auto-capture. Configure opencode provider or memory API settings.");
  }

  const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
  const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");

  const providerConfig = buildMemoryProviderConfig(CONFIG);
  const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);

  const systemPrompt = `You are a technical memory recorder for a software development project.

RULES:
1. ONLY capture technical work (code, bugs, features, architecture, config)
2. SKIP non-technical by returning type="skip"
3. NO meta-commentary or behavior analysis
4. Include specific file names, functions, technical details
5. Generate 2-4 technical tags (e.g., "react", "auth", "bug-fix")
6. You MUST write the summary in ${langName}.${syncInstr}

FORMAT:
## Request
[1-2 sentences: what was requested, in ${langName}]

## Outcome
[1-2 sentences: what was done, include files/functions, in ${langName}]

SKIP if: greetings, casual chat, no code/decisions made
CAPTURE if: code changed, bug fixed, feature added, decision made`;

  const aiPrompt = `${context}

Analyze this conversation. If it contains technical work (code, bugs, features, decisions), create a concise summary and relevant tags. If it's non-technical (greetings, casual chat, incomplete requests), return type="skip" with empty summary.`;

  const toolSchema = {
    type: "function" as const,
    function: {
      name: "save_memory",
      description: "Save the conversation summary as a memory",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Markdown-formatted summary of the conversation",
          },
          type: {
            type: "string",
            description:
              "Type of memory: 'skip' for non-technical conversations, or technical type (feature, bug-fix, refactor, analysis, configuration, discussion, other)",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "List of 2-4 technical tags related to the memory",
          },
          sync_to_central: {
            type: "boolean",
            description: "Whether this memory should be synced to the central server",
          },
        },
        required: ["summary", "type", "tags"],
      },
    },
  };

  const result = await provider.executeToolCall(systemPrompt, aiPrompt, toolSchema, sessionID);

  if (!result.success || !result.data) {
    throw new Error(result.error || "Failed to generate summary");
  }

  return {
    summary: result.data.summary,
    type: result.data.type,
    tags: (result.data.tags || []).map((t: string) => t.toLowerCase().trim()),
    sync_to_central: result.data.sync_to_central || false,
  };
}
