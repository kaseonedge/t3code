import { type MemoryError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MemoryService from "../../../memory/MemoryService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MemoryToolkit } from "./tools.ts";

const refused = (error: MemoryError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "not-voice-thread"
        ? "capability_denied"
        : error.reason === "unavailable"
          ? "orchestration_error"
          : "invalid_request",
    message: error.message,
  });

const callerThreadId = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
  Effect.map((scope) => scope.thread.threadId),
);

const handlers = {
  memory_search: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      return yield* memory.recall(yield* callerThreadId, input).pipe(Effect.mapError(refused));
    }),
  ),
  memory_write: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      return yield* memory.remember(yield* callerThreadId, input).pipe(Effect.mapError(refused));
    }),
  ),
  memory_forget: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      const forgotten = yield* memory
        .forgetAs(yield* callerThreadId, input.id)
        .pipe(Effect.mapError(refused));
      return { forgotten };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof MemoryToolkit.tools>;

export const layer = McpToolAccess.toLayer(MemoryToolkit, handlers);
