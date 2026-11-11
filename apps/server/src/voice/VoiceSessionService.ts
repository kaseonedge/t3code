import {
  CloudSpeechApiKey,
  CommandId,
  isSecretReference,
  MessageId,
  type OrchestrationV2Run,
  type ThreadId,
  VOICE_MESSAGE_ID_PREFIX,
  VOICE_UTTERANCE_PREFIX,
  type VoiceHealthEntry,
  type VoiceSayInput,
  type VoiceSayResult,
  VoiceSessionError,
  type VoiceSessionEvent,
  type VoiceStatusResult,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";
import { spokenForm } from "./spokenForm.ts";
import { voiceSayLimitViolation } from "./turnFilter.ts";
import { makeVoiceSession, type VoiceSession } from "./VoiceSession.ts";
import * as VoiceSpeechProvider from "./VoiceSpeechProvider.ts";

const isApiKey = Schema.is(CloudSpeechApiKey);
const MAX_HEALTH_ENTRIES = 50;
const SETUP_REASONS: ReadonlySet<string> = new Set([
  "not-configured",
  "no-router",
  "already-active",
]);

// A turn the user stopped is left silent: they know why nothing came.
const SILENT_ENDINGS: Partial<Record<OrchestrationV2Run["status"], string>> = {
  completed: "I'm done, with nothing to read out. The thread has the details.",
  failed: "That didn't work. The thread has the details.",
};

export class VoiceSayRefusedError extends Schema.TaggedError<VoiceSayRefusedError>()(
  "VoiceSayRefusedError",
  {
    reason: Schema.Literals(["not-voice-thread", "no-conversation", "too-long", "queue-full"]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-voice-thread":
        return "Only the thread chosen to answer voice conversations can speak or read voice status.";
      case "no-conversation":
        return "No voice conversation is running, so nothing was spoken. Reply in text instead.";
      case "too-long":
        return this.detail ?? "Too long to say aloud. Nothing was spoken.";
      case "queue-full":
        return "Too much is already waiting to be said. Nothing was added. Try again once the user has heard it.";
    }
  }
}

export interface VoiceSessionIo {
  readonly send: (event: VoiceSessionEvent) => Effect.Effect<void>;
  readonly sendAudio: (frame: Uint8Array) => Effect.Effect<void>;
}

export class VoiceSessionService extends Context.Service<
  VoiceSessionService,
  {
    /**
     * Starts the environment's one voice conversation, which lasts for the scope. Fails before
     * any audio leaves this machine when the key, voice or voice thread is missing or unreadable.
     */
    readonly open: (
      io: VoiceSessionIo,
    ) => Effect.Effect<
      VoiceSession & { readonly routerThreadId: ThreadId },
      VoiceSessionError,
      Scope.Scope
    >;
    readonly say: (
      caller: ThreadId,
      input: VoiceSayInput,
    ) => Effect.Effect<VoiceSayResult, VoiceSayRefusedError>;
    /** For the voice thread, and for the watchdog thread that checks on it. */
    readonly status: (caller: ThreadId) => Effect.Effect<VoiceStatusResult, VoiceSayRefusedError>;
    /** Recent conversation failures, oldest first. They outlive the conversation they happened in. */
    readonly health: Effect.Effect<ReadonlyArray<VoiceHealthEntry>>;
  }
>()("t3/voice/VoiceSessionService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const resolver = yield* SecretResolver.SecretResolver;
  const speech = yield* VoiceSpeechProvider.VoiceSpeechProvider;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;
  const health: Array<VoiceHealthEntry> = [];
  let healthSeq = 0;
  const noteHealth = (kind: VoiceHealthEntry["kind"]) =>
    DateTime.now.pipe(
      Effect.map((now) => {
        health.push({ seq: ++healthSeq, at: DateTime.formatIso(now), kind });
        if (health.length > MAX_HEALTH_ENTRIES) health.shift();
      }),
    );
  // Whether the voice thread has spoken through `voice_say` since the user's last turn.
  let saidByTool = false;
  // Whether the user's last turn has been met with nothing aloud yet.
  let unanswered = false;
  let owner: symbol | undefined;
  let active: VoiceSession | undefined;
  const release = (claim: symbol) => {
    if (owner !== claim) return;
    owner = undefined;
    active = undefined;
  };

  const fail = (reason: VoiceSessionError["reason"]) => new VoiceSessionError({ reason });
  const readSettings = settings.getSettings.pipe(Effect.mapError(() => fail("unavailable")));

  const dispatchUtterance = (threadId: ThreadId) =>
    Effect.fn("VoiceSessionService.dispatchUtterance")(function* (text: string) {
      saidByTool = false;
      unanswered = true;
      const id = yield* random.uuidV4();
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`voice:${id}`),
          threadId,
          messageId: MessageId.make(`${VOICE_MESSAGE_ID_PREFIX}${id}`),
          text: `${VOICE_UTTERANCE_PREFIX}${text}`,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          // Steers a running turn where the provider can, so the user is heard mid-task.
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(
          Effect.tapError((cause) => Effect.logWarning("voice turn was not dispatched", { cause })),
          Effect.mapError(() => fail("router-unavailable")),
        );
    });

  /**
   * Says the voice thread's written replies aloud, so the conversation works with any model: one
   * that never calls `voice_say` is still heard. A turn in which the thread did speak through the
   * tool is left alone, or the user would hear the same answer twice.
   */
  const speakReplies = Effect.fn("VoiceSessionService.speakReplies")(function* (
    session: VoiceSession,
    routerThreadId: ThreadId,
  ) {
    const scope = yield* Scope.Scope;
    const replies = yield* Queue.unbounded<ReadonlyArray<string>>();
    const seen = new Set<string>();
    // One reply at a time, in order. Cutting the bot off drops the rest of what it meant to say.
    yield* Effect.forever(
      Effect.gen(function* () {
        for (const chunk of yield* Queue.take(replies)) {
          const result = yield* session
            .say(chunk, "reply")
            .pipe(Effect.orElseSucceed(() => ({ outcome: "interrupted" as const })));
          if (result.outcome !== "interrupted") continue;
          yield* Queue.clear(replies);
          break;
        }
      }),
    ).pipe(Effect.forkIn(scope));
    yield* Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
      if (event.threadId !== routerThreadId) return Effect.void;
      if (event.type === "run.updated") {
        // Silence after a question reads as a broken call, so a turn that ends unheard says so.
        const ending = unanswered ? SILENT_ENDINGS[event.payload.status] : undefined;
        if (ending === undefined) return Effect.void;
        unanswered = false;
        return Queue.offer(replies, [ending]);
      }
      if (
        event.type !== "message.updated" ||
        event.payload.role !== "assistant" ||
        event.payload.streaming ||
        seen.has(event.payload.id)
      )
        return Effect.void;
      seen.add(event.payload.id);
      const chunks = saidByTool ? [] : spokenForm(event.payload.text);
      if (chunks.length === 0) return Effect.void;
      unanswered = false;
      return Queue.offer(replies, chunks);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("voice replies stopped being read aloud", { cause }),
      ),
      Effect.forkIn(scope),
    );
  });

  const start = Effect.fn("VoiceSessionService.start")(function* (io: VoiceSessionIo) {
    const { elevenLabs, voiceRouterThreadId } = yield* readSettings;
    if (voiceRouterThreadId === null) return yield* fail("no-router");
    const shell = yield* threads
      .getThreadShell(voiceRouterThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null)
      return yield* fail("no-router");
    const source = elevenLabs.apiKey;
    if (!source || !elevenLabs.voiceId) return yield* fail("not-configured");
    // A vault that locked since the last conversation must not authorize a new one.
    if (isSecretReference(source)) yield* resolver.invalidate([source]);
    const key = yield* requireSettingsSecret(resolver, source).pipe(
      Effect.mapError(() => fail("unreadable-key")),
    );
    if (!isApiKey(key)) return yield* fail("unreadable-key");
    const config = { ...elevenLabs, apiKey: Redacted.make(key), voiceId: elevenLabs.voiceId };
    const session = yield* makeVoiceSession({
      connect: (sinks) => speech.connect(config, sinks),
      onHealth: noteHealth,
      ...io,
      dispatchUtterance: dispatchUtterance(voiceRouterThreadId),
    });
    active = session;
    saidByTool = false;
    unanswered = false;
    yield* speakReplies(session, voiceRouterThreadId);
    return { ...session, routerThreadId: voiceRouterThreadId };
  });

  const open: VoiceSessionService["Service"]["open"] = Effect.fn("VoiceSessionService.open")(
    function* (io) {
      if (owner !== undefined) return yield* fail("already-active");
      const claim = Symbol("voice conversation");
      owner = claim;
      yield* Effect.addFinalizer(() => Effect.sync(() => release(claim)));
      // A start that failed holds nothing, so the next one need not wait for this scope to close.
      return yield* start(io).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => release(claim)).pipe(
            // Missing setup is the user's to finish, not a fault for a watchdog to report.
            Effect.andThen(
              SETUP_REASONS.has(error.reason) ? Effect.void : noteHealth(error.reason),
            ),
          ),
        ),
      );
    },
  );

  const requireVoiceThread = Effect.fn("VoiceSessionService.requireVoiceThread")(function* (
    caller: ThreadId,
    orWatchdog = false,
  ) {
    const { voiceRouterThreadId, voiceWatchdogThreadId } = yield* settings.getSettings.pipe(
      Effect.orElseSucceed(() => ({ voiceRouterThreadId: null, voiceWatchdogThreadId: null })),
    );
    if (caller !== voiceRouterThreadId && !(orWatchdog && caller === voiceWatchdogThreadId))
      return yield* new VoiceSayRefusedError({ reason: "not-voice-thread" });
    return voiceRouterThreadId;
  });

  const say: VoiceSessionService["Service"]["say"] = Effect.fn("VoiceSessionService.say")(
    function* (caller, input) {
      yield* requireVoiceThread(caller);
      const violation = voiceSayLimitViolation(input.text);
      if (violation !== undefined)
        return yield* new VoiceSayRefusedError({ reason: "too-long", detail: violation });
      if (active === undefined)
        return yield* new VoiceSayRefusedError({ reason: "no-conversation" });
      saidByTool = true;
      unanswered = false;
      return yield* active
        .say(input.text.trim(), input.priority ?? "reply")
        .pipe(Effect.mapError(() => new VoiceSayRefusedError({ reason: "queue-full" })));
    },
  );

  const status: VoiceSessionService["Service"]["status"] = Effect.fn("VoiceSessionService.status")(
    function* (caller) {
      const routerThreadId = yield* requireVoiceThread(caller, true);
      if (active === undefined)
        return {
          active: false,
          routerThreadId,
          userSpeaking: false,
          quiet: false,
          speaking: null,
          queued: 0,
          lastHeard: null,
          lastSpoken: null,
        };
      return { active: true, routerThreadId, ...(yield* active.status) };
    },
  );

  return VoiceSessionService.of({ open, say, status, health: Effect.sync(() => [...health]) });
});

export const layer = Layer.effect(VoiceSessionService, make);
