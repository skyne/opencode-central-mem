import type { PluginModule } from "@opencode-ai/plugin";
import pkg from "../package.json" with { type: "json" };
const { OpenCodeMemPlugin } = await import("./index.js");

export const id = "opencode-central-mem";
export { OpenCodeMemPlugin };
export default { id, server: OpenCodeMemPlugin } satisfies PluginModule;
