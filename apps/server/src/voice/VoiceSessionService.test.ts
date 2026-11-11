import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  SecretProviderId,
  ThreadId,
  type VoiceSessionEvent,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VoiceSessionService from "./VoiceSessionService.ts";
import {
  type VoiceSpeechConfig,
  VoiceSpeechProvider,
  type VoiceSpeechSinks,
} from "./VoiceSpeechProvider.ts";

const KEY = "xi-fixture-key-not-real";
const router = ThreadId.make("voice-router");
const watchdog = ThreadId.make("voice-watchdog");
const reference = { provider: SecretProviderId.make("work"), reference: "op://Work/Voice/key" };
type SettingsOverrides = NonNullable<
  Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0]
>;

const setup = Effect.fn("test.voiceService.setup")(function* (
  settings: SettingsOverrides = {},
  options: { readonly archived?: boolean; readonly holdSpeech?: boolean } = {},
) {
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const spoken: string[] = [];
  const vault = { secret: KEY as string | undefined, invalidated: 0 };
  const connections: Array<{ config: VoiceSpeechConfig; sinks: VoiceSpeechSinks }> = [];
  const commands: OrchestrationV2ServerCommand[] = [];
  const frames = yield* Queue.unbounded<VoiceSessionEvent>();
  const voice = yield* VoiceSessionService.VoiceSessionService.pipe(
    Effect.provide(
      VoiceSessionService.layer.pipe(
        Layer.provide(
          ServerSettings.ServerSettingsService.layerTest({
            elevenLabs: { apiKey: reference, voiceId: "VoiceFixture01" },
            voiceRouterThreadId: router,
            voiceWatchdogThreadId: watchdog,
            ...settings,
          }),
        ),
        Layer.provide(
          Layer.mock(SecretResolver.SecretResolver)({
            read: () => Effect.sync(() => [vault.secret]),
            label: () => Effect.succeed("Work"),
            invalidate: () => Effect.sync(() => void vault.invalidated++),
          }),
        ),
        Layer.provide(
          Layer.mock(VoiceSpeechProvider)({
            connect: (config, sinks) =>
              Effect.sync(() => {
                connections.push({ config, sinks });
                return {
                  transcriber: { send: () => Effect.void },
                  synthesizer: {
                    speak: (contextId, text) =>
                      Effect.sync(() => void spoken.push(text)).pipe(
                        Effect.andThen(
                          options.holdSpeech
                            ? sinks.onSynthesizer({
                                type: "audio",
                                contextId,
                                pcm: new Uint8Array(48_000),
                              })
                            : sinks.onSynthesizer({ type: "done", contextId }),
                        ),
                      ),
                    cancel: () => Effect.void,
                  },
                };
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                deletedAt: null,
                archivedAt: options.archived ? "2026-01-01T00:00:00.000Z" : null,
              } as never),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: 1 } as never;
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
        ),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
  );
  let messageCount = 0;
  /** The voice thread, or another thread, finishes or streams a written reply. */
  const reply = (
    text: string,
    overrides: { threadId?: ThreadId; streaming?: boolean; id?: string } = {},
  ) =>
    Queue.offer(events, {
      type: "message.updated",
      threadId: overrides.threadId ?? router,
      payload: {
        id: overrides.id ?? `message:${++messageCount}`,
        role: "assistant",
        streaming: overrides.streaming ?? false,
        text,
      },
    } as never);
  /** A run on the voice thread, or another thread, ends. */
  const ends = (status: string, threadId: ThreadId = router) =>
    Queue.offer(events, { type: "run.updated", threadId, payload: { status } } as never);
  const next = <T extends VoiceSessionEvent["type"]>(type: T) =>
    Queue.take(frames).pipe(
      Effect.repeat({ until: (frame) => frame.type === type }),
      Effect.map((frame) => frame as Extract<VoiceSessionEvent, { type: T }>),
    );
  /** Waits for the bot to start saying something and lets it finish. */
  const hears = Effect.fn("test.voiceService.hears")(function* () {
    const started = yield* next("speech_start");
    yield* TestClock.adjust("1 millis");
    yield* next("speech_end");
    return started.text;
  });
  const io = {
    send: (event: VoiceSessionEvent) => Queue.offer(frames, event),
    sendAudio: () => Effect.void,
  };
  return {
    voice,
    vault,
    connections,
    commands,
    frames,
    spoken,
    reply,
    ends,
    next,
    hears,
    open: voice.open(io),
  };
});

it.effect("no audio leaves this machine until the key is read, and the key is never shown", () => {
  const logs: string[] = [];
  const logger = Logger.make(({ message, cause }) => {
    logs.push(JSON.stringify([message, String(cause)]));
  });
  return Effect.gen(function* () {
    const test = yield* setup();
    test.vault.secret = undefined;
    const locked = yield* Effect.flip(test.open);
    expect(locked).toMatchObject({ _tag: "VoiceSessionError", reason: "unreadable-key" });
    expect(test.connections).toEqual([]);
    // Kept for the watchdog after the failed start is gone.
    expect(yield* test.voice.health).toMatchObject([{ seq: 1, kind: "unreadable-key" }]);

    test.vault.secret = KEY;
    const session = yield* test.open;
    // The vault is asked again each time, so one that locked since cannot authorize a new start.
    expect(test.vault.invalidated).toBe(2);
    expect(session.routerThreadId).toBe(router);
    const [{ config } = { config: undefined }] = test.connections;
    expect(Redacted.value(config!.apiKey)).toBe(KEY);
    const shown = [
      JSON.stringify(config),
      String(config!.apiKey),
      `${locked.message} ${JSON.stringify(locked)}`,
      JSON.stringify(yield* test.voice.status(router)),
      logs.join("\n"),
    ].join("\n");
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain("op://");
  }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger])));
});

it.effect.each([
  [{ elevenLabs: { apiKey: "" } }, {}, "not-configured"],
  [{ elevenLabs: { voiceId: "" } }, {}, "not-configured"],
  [{ voiceRouterThreadId: null }, {}, "no-router"],
  [{}, { archived: true }, "no-router"],
] as const)("refuses to start with %o %o", ([settings, options, reason]) =>
  Effect.gen(function* () {
    const test = yield* setup(settings, options);
    expect(yield* Effect.flip(test.open)).toMatchObject({ reason });
    expect(test.connections).toEqual([]);
    // Unfinished setup is not a fault to report.
    expect(yield* test.voice.health).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("one conversation at a time, and ending it frees the environment", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    const first = yield* Scope.make();
    yield* test.open.pipe(Scope.provide(first));
    expect(yield* Effect.flip(test.open)).toMatchObject({ reason: "already-active" });
    expect(yield* test.voice.status(router)).toMatchObject({ active: true });
    yield* Scope.close(first, Exit.void);
    expect(yield* test.voice.status(router)).toMatchObject({ active: false });
    yield* test.open;
  }).pipe(Effect.scoped),
);

it.effect("a spoken turn reaches the voice thread as an auto-delivered message", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    yield* test.open;
    yield* test.connections[0]!.sinks.onTranscriber({
      type: "committed",
      text: "Fix the login bug.",
    });
    yield* Queue.take(test.frames).pipe(
      Effect.repeat({ until: (frame) => frame.type === "acknowledged" }),
    );
    yield* TestClock.adjust("1 millis");
    expect(test.commands).toMatchObject([
      {
        type: "message.dispatch",
        threadId: router,
        text: "[voice] Fix the login bug.",
        createdBy: "user",
        deliveryIntent: "auto",
        dispatchMode: { type: "start_immediately" },
      },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("only the voice thread speaks, within the spoken length limit", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    const say = (caller: ThreadId, text: string) => test.voice.say(caller, { text });
    expect(yield* Effect.flip(say(router, "Hello."))).toMatchObject({ reason: "no-conversation" });
    yield* test.open;
    expect(yield* Effect.flip(say(ThreadId.make("worker"), "Hello."))).toMatchObject({
      reason: "not-voice-thread",
    });
    expect(yield* Effect.flip(test.voice.status(ThreadId.make("worker")))).toMatchObject({
      reason: "not-voice-thread",
    });
    // The watchdog thread may look, but not speak.
    expect(yield* test.voice.status(watchdog)).toMatchObject({ active: true });
    expect(yield* Effect.flip(say(watchdog, "Hello."))).toMatchObject({
      reason: "not-voice-thread",
    });
    const long = yield* Effect.flip(say(router, "One. Two. Three."));
    expect(long.message).toContain("3 sentences");
    expect(
      yield* Effect.flip(say(router, Array.from({ length: 41 }, () => "word").join(" "))),
    ).toMatchObject({
      reason: "too-long",
    });
    const spoken = yield* say(router, "The build passed. I opened a pull request.").pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* test.voice.status(router);
    yield* TestClock.adjust("1 millis");
    expect(yield* Fiber.join(spoken)).toEqual({
      outcome: "delivered",
      spokenText: "The build passed. I opened a pull request.",
    });
  }).pipe(Effect.scoped),
);

it.effect("reads the voice thread's written replies aloud, once each, and nobody else's", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    yield* test.open;
    // Still being written, and another thread's reply: neither is spoken.
    yield* test.reply("Hey! Astra", { streaming: true, id: "message:a" });
    yield* test.reply("Unrelated work finished.", { threadId: ThreadId.make("worker") });
    yield* test.reply("Hey! **Astra** here. I can hear you.", { id: "message:a" });
    expect(yield* test.hears()).toBe("Hey! Astra here. I can hear you.");
    // The same finished message arriving again is not said twice.
    yield* test.reply("Hey! **Astra** here. I can hear you.", { id: "message:a" });
    yield* test.reply("Got it.");
    expect(yield* test.hears()).toBe("Got it.");
    expect(test.spoken).toEqual(["Hey! Astra here. I can hear you.", "Got it."]);
  }).pipe(Effect.scoped),
);

it.effect("does not repeat aloud a reply the voice thread already spoke with voice_say", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    yield* test.open;
    const said = yield* test.voice
      .say(router, { text: "The build passed." })
      .pipe(Effect.forkChild({ startImmediately: true }));
    expect(yield* test.hears()).toBe("The build passed.");
    yield* Fiber.join(said);
    yield* test.reply("The build passed. Full log: 412 tests, 0 failures.");

    // The user's next turn starts a fresh reply, which is read aloud again.
    yield* test.connections[0]!.sinks.onTranscriber({ type: "committed", text: "And the docs?" });
    yield* test.next("acknowledged");
    yield* test.reply("Docs are done too.");
    expect(yield* test.hears()).toBe("Docs are done too.");
    expect(test.spoken).toEqual(["The build passed.", "Docs are done too."]);
  }).pipe(Effect.scoped),
);

it.effect("a turn that ends with nothing said aloud is not met with silence", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    yield* test.open;
    const asks = Effect.fn("test.voiceService.asks")(function* (text: string) {
      yield* test.connections[0]!.sinks.onTranscriber({ type: "committed", text });
      yield* test.next("acknowledged");
    });
    // Nobody asked anything yet, so a run ending is not the user's business.
    yield* test.ends("completed");

    yield* asks("Run the migration.");
    // Still working, another thread's failure, and a turn the user stopped: all stay quiet.
    yield* test.ends("running");
    yield* test.ends("failed", ThreadId.make("worker"));
    yield* test.ends("interrupted");
    yield* test.ends("failed");
    expect(yield* test.hears()).toBe("That didn't work. The thread has the details.");
    // Said once per turn.
    yield* test.ends("failed");

    yield* asks("Tidy the branch.");
    yield* test.ends("completed");
    expect(yield* test.hears()).toBe(
      "I'm done, with nothing to read out. The thread has the details.",
    );

    // A turn that was answered ends without comment.
    yield* asks("Thanks.");
    yield* test.reply("Any time.");
    expect(yield* test.hears()).toBe("Any time.");
    yield* test.ends("completed");
    yield* test.reply("Closing note.");
    expect(yield* test.hears()).toBe("Closing note.");
    expect(test.spoken).toHaveLength(4);
  }).pipe(Effect.scoped),
);

it.effect("cutting the bot off drops the rest of what it was reading out", () =>
  Effect.gen(function* () {
    const test = yield* setup({}, { holdSpeech: true });
    yield* test.open;
    const sentence =
      "This sentence is long enough that only a few of them fit in one breath of speech.";
    yield* test.reply(Array.from({ length: 6 }, () => sentence).join(" "));
    yield* test.reply("A second reply that is now stale.");
    yield* test.next("speech_start");
    yield* test.connections[0]!.sinks.onTranscriber({ type: "partial", text: "wait, stop there" });
    yield* test.next("clear");
    yield* TestClock.adjust("1 second");
    expect(yield* test.next("speech_end")).toMatchObject({ outcome: "interrupted" });
    yield* test.connections[0]!.sinks.onTranscriber({
      type: "committed",
      text: "Wait, stop there.",
    });
    yield* test.next("acknowledged");
    yield* test.voice.status(router);
    expect(test.spoken).toHaveLength(1);
    expect(yield* test.voice.status(router)).toMatchObject({ speaking: null, queued: 0 });
  }).pipe(Effect.scoped),
);
