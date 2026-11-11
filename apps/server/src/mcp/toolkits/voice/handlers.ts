import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as VoiceSessionService from "../../../voice/VoiceSessionService.ts";
import * as VoiceWatch from "../../../voice/VoiceWatch.ts";
import * as VoiceWatchdog from "../../../voice/VoiceWatchdog.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { VoiceToolkit } from "./tools.ts";

const refused = (error: VoiceSessionService.VoiceSayRefusedError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "not-voice-thread" ? "capability_denied" : "invalid_request",
    message: error.message,
  });

const callerThreadId = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
  Effect.map((scope) => scope.thread.threadId),
);

const handlers = {
  voice_say: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const voice = yield* VoiceSessionService.VoiceSessionService;
      return yield* voice.say(yield* callerThreadId, input).pipe(Effect.mapError(refused));
    }),
  ),
  voice_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const voice = yield* VoiceSessionService.VoiceSessionService;
      return yield* voice.status(yield* callerThreadId).pipe(Effect.mapError(refused));
    }),
  ),
  voice_watch: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const watch = yield* VoiceWatch.VoiceWatch;
      return yield* watch.change(yield* callerThreadId, input.action, input.threadId).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code:
                error.reason === "not-voice-thread"
                  ? "capability_denied"
                  : error.reason === "thread-not-found"
                    ? "thread_not_found"
                    : error.reason === "unavailable"
                      ? "orchestration_error"
                      : "invalid_request",
              message: error.message,
            }),
        ),
      );
    }),
  ),
  // Reading marks findings as told, so it is a write: a read-only client must not consume them.
  voice_health: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const watchdog = yield* VoiceWatchdog.VoiceWatchdog;
      return yield* watchdog.report(yield* callerThreadId).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code:
                error.reason === "not-watchdog-thread"
                  ? "capability_denied"
                  : "orchestration_error",
              message: error.message,
            }),
        ),
      );
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof VoiceToolkit.tools>;

export const layer = McpToolAccess.toLayer(VoiceToolkit, handlers);
