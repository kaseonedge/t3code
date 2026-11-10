import {
  CloudSpeechApiKey,
  CommandId,
  isSecretReference,
  MessageId,
  type ThreadId,
  type VoiceSayInput,
  type VoiceSayResult,
  VoiceSessionError,
  type VoiceSessionEvent,
  type VoiceStatusResult,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";
import { voiceSayLimitViolation } from "./turnFilter.ts";
import { makeVoiceSession, type VoiceSession } from "./VoiceSession.ts";
import * as VoiceSpeechProvider from "./VoiceSpeechProvider.ts";

/** Marks a message the user spoke, so the voice thread answers aloud. */
const VOICE_UTTERANCE_MARKER = "[voice]";

const isApiKey = Schema.is(CloudSpeechApiKey);

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
    readonly status: (caller: ThreadId) => Effect.Effect<VoiceStatusResult, VoiceSayRefusedError>;
  }
>()("t3/voice/VoiceSessionService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const resolver = yield* SecretResolver.SecretResolver;
  const speech = yield* VoiceSpeechProvider.VoiceSpeechProvider;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
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
      const id = yield* random.uuidV4();
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`voice:${id}`),
          threadId,
          messageId: MessageId.make(`voice-message:${id}`),
          text: `${VOICE_UTTERANCE_MARKER} ${text}`,
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
      ...io,
      dispatchUtterance: dispatchUtterance(voiceRouterThreadId),
    });
    active = session;
    return { ...session, routerThreadId: voiceRouterThreadId };
  });

  const open: VoiceSessionService["Service"]["open"] = Effect.fn("VoiceSessionService.open")(
    function* (io) {
      if (owner !== undefined) return yield* fail("already-active");
      const claim = Symbol("voice conversation");
      owner = claim;
      yield* Effect.addFinalizer(() => Effect.sync(() => release(claim)));
      // A start that failed holds nothing, so the next one need not wait for this scope to close.
      return yield* start(io).pipe(Effect.tapError(() => Effect.sync(() => release(claim))));
    },
  );

  const requireVoiceThread = Effect.fn("VoiceSessionService.requireVoiceThread")(function* (
    caller: ThreadId,
  ) {
    const routerThreadId = yield* settings.getSettings.pipe(
      Effect.map((current) => current.voiceRouterThreadId),
      Effect.orElseSucceed(() => null),
    );
    if (routerThreadId === null || routerThreadId !== caller)
      return yield* new VoiceSayRefusedError({ reason: "not-voice-thread" });
    return routerThreadId;
  });

  const say: VoiceSessionService["Service"]["say"] = Effect.fn("VoiceSessionService.say")(
    function* (caller, input) {
      yield* requireVoiceThread(caller);
      const violation = voiceSayLimitViolation(input.text);
      if (violation !== undefined)
        return yield* new VoiceSayRefusedError({ reason: "too-long", detail: violation });
      if (active === undefined)
        return yield* new VoiceSayRefusedError({ reason: "no-conversation" });
      return yield* active
        .say(input.text.trim(), input.priority ?? "reply")
        .pipe(Effect.mapError(() => new VoiceSayRefusedError({ reason: "queue-full" })));
    },
  );

  const status: VoiceSessionService["Service"]["status"] = Effect.fn("VoiceSessionService.status")(
    function* (caller) {
      const routerThreadId = yield* requireVoiceThread(caller);
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

  return VoiceSessionService.of({ open, say, status });
});

export const layer = Layer.effect(VoiceSessionService, make);
