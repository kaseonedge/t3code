import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import {
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
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
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
const reference = { provider: SecretProviderId.make("work"), reference: "op://Work/Voice/key" };
type SettingsOverrides = NonNullable<
  Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0]
>;

const setup = Effect.fn("test.voiceService.setup")(function* (
  settings: SettingsOverrides = {},
  options: { readonly archived?: boolean } = {},
) {
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
                    speak: (contextId) => sinks.onSynthesizer({ type: "done", contextId }),
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
        Layer.provide(NodeCrypto.layer),
      ),
    ),
  );
  const io = {
    send: (event: VoiceSessionEvent) => Queue.offer(frames, event),
    sendAudio: () => Effect.void,
  };
  return { voice, vault, connections, commands, frames, open: voice.open(io) };
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
