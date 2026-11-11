import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Notification,
  type OrchestrationV2Run,
  type ThreadId,
  VOICE_WATCH_LIMIT,
  type VoiceWatchResult,
} from "@t3tools/contracts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

/** A spoken summary needs the gist; the voice thread reads the rest when asked. */
const MAX_RESULT_CHARS = 4_000;

const OUTCOMES: Partial<
  Record<OrchestrationV2Run["status"], OrchestrationV2Notification["outcome"]>
> = { completed: "completed", failed: "failed", cancelled: "cancelled", interrupted: "cancelled" };

export class VoiceWatchRefusedError extends Schema.TaggedError<VoiceWatchRefusedError>()(
  "VoiceWatchRefusedError",
  {
    reason: Schema.Literals([
      "not-voice-thread",
      "thread-required",
      "thread-not-found",
      "own-thread",
      "full",
      "unavailable",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-voice-thread":
        return "Only the thread chosen to answer voice conversations can change what it watches.";
      case "thread-required":
        return "Name the thread with `threadId`.";
      case "thread-not-found":
        return "That thread was not found, so it is not watched.";
      case "own-thread":
        return "The voice thread cannot watch itself.";
      case "full":
        return `The watch list is full at ${VOICE_WATCH_LIMIT} threads. Unwatch one first.`;
      case "unavailable":
        return "The watch list could not be read or saved.";
    }
  }
}

export class VoiceWatch extends Context.Service<
  VoiceWatch,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Tells the voice thread when a watched thread's run ends. */
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly change: (
      caller: ThreadId,
      action: "watch" | "unwatch" | "list",
      threadId: ThreadId | undefined,
    ) => Effect.Effect<VoiceWatchResult, VoiceWatchRefusedError>;
  }
>()("t3/voice/VoiceWatch") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const refuse = (reason: VoiceWatchRefusedError["reason"]) =>
    new VoiceWatchRefusedError({ reason });
  const readSettings = settings.getSettings.pipe(Effect.mapError(() => refuse("unavailable")));

  const change: VoiceWatch["Service"]["change"] = Effect.fn("VoiceWatch.change")(
    function* (caller, action, threadId) {
      const current = yield* readSettings;
      if (current.voiceRouterThreadId === null || current.voiceRouterThreadId !== caller)
        return yield* refuse("not-voice-thread");
      const watched = current.voiceWatchedThreadIds;
      const result = (ids: ReadonlyArray<ThreadId>) => ({ watched: ids, limit: VOICE_WATCH_LIMIT });
      if (action === "list") return result(watched);
      if (threadId === undefined) return yield* refuse("thread-required");
      const next =
        action === "unwatch"
          ? watched.filter((id) => id !== threadId)
          : watched.includes(threadId)
            ? watched
            : [...watched, threadId];
      if (next.length === watched.length) return result(watched);
      if (action === "watch") {
        if (threadId === caller) return yield* refuse("own-thread");
        if (next.length > VOICE_WATCH_LIMIT) return yield* refuse("full");
        const thread = yield* projections
          .getThread(threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (thread === null || thread.deletedAt !== null) return yield* refuse("thread-not-found");
      }
      yield* settings
        .updateSettings({ voiceWatchedThreadIds: next })
        .pipe(Effect.mapError(() => refuse("unavailable")));
      return result(next);
    },
  );

  // Runs for every domain event; all but a watched thread's finished run return at once.
  const handle: VoiceWatch["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated") return;
      const outcome = OUTCOMES[event.payload.status];
      if (outcome === undefined) return;
      const current = yield* settings.getSettings;
      const router = current.voiceRouterThreadId;
      if (
        router === null ||
        event.threadId === router ||
        !current.voiceWatchedThreadIds.includes(event.threadId)
      )
        return;
      const records = yield* projections.getThreadRecords(event.threadId, [
        "messages",
        "turnItems",
        "providerTurns",
      ]);
      // A thread the voice thread delegated already wakes it through the delegated-task channel.
      if (records.thread.lineage.parentThreadId === router) return;
      const { text } = subagentResultForRun(records, event.payload);
      const characters = Array.from(text);
      const shown = characters.slice(0, MAX_RESULT_CHARS).join("");
      const key = `${event.threadId}:${event.payload.id}`;
      const title = records.thread.title.trim() || "Untitled thread";
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:voice-watch:${key}`),
        threadId: router,
        messageId: MessageId.make(`message:voice-watch:${key}`),
        text:
          `Watched thread ${event.threadId} (${title}) [${event.payload.status}]:\n${shown || "(no final message)"}` +
          (characters.length > MAX_RESULT_CHARS
            ? `\nThe result is longer. Read the rest with t3_thread_read, threadId ${event.threadId}.`
            : ""),
        notification: {
          source: { kind: "system" },
          outcome,
          summary: `Watched thread "${title}" ${event.payload.status}`,
        },
        attachments: [],
        // Queued, so the existing delivery policy alone decides when the voice thread sees it.
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("telling the voice thread about a watched thread failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: VoiceWatch["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("voice watch event stream failed", { cause }),
        ),
      ),
    );

  return VoiceWatch.of({ start, handle, change });
});

export const layer = Layer.effect(VoiceWatch, make);
