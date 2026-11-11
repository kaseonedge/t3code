import {
  Memory,
  MemoryForgetInput,
  MemoryForgetResult,
  MemoryList,
  MemorySearchInput,
  MemoryWriteInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as MemoryService from "../../../memory/MemoryService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const tool = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    MemoryService.MemoryService,
  ],
};

const MemorySearchTool = Tool.make("memory_search", {
  ...tool,
  description:
    "Search what you remembered in earlier conversations: facts, the user's preferences, and decisions. Best matches first. Each result says which thread it came from; read that thread for the detail.",
  parameters: MemorySearchInput,
  success: MemoryList,
})
  .annotate(Tool.Title, "Search long-term memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const MemoryWriteTool = Tool.make("memory_write", {
  ...tool,
  description:
    "Remember one thing for future conversations: a lasting fact, a preference, or a decision. Not task progress, and never a password, key or token; those are refused.",
  parameters: MemoryWriteInput,
  success: Memory,
})
  .annotate(Tool.Title, "Save to long-term memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const MemoryForgetTool = Tool.make("memory_forget", {
  ...tool,
  description:
    "Delete one memory by the `id` from `memory_search`, when it is wrong, out of date, or the user asks.",
  parameters: MemoryForgetInput,
  success: MemoryForgetResult,
})
  .annotate(Tool.Title, "Forget a memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MemoryToolkit = Toolkit.make(MemorySearchTool, MemoryWriteTool, MemoryForgetTool);
