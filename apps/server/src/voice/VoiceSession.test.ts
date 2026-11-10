import { it } from "@effect/vitest";
import {
  decodeVoiceSessionAudioFrame,
  type VoiceSayPriority,
  VoiceSessionError,
  type VoiceSessionEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import {
  AUDIO_IDLE_TIMEOUT,
  CLEAR_ACK_TIMEOUT,
  HELD_REPORT_DELAY,
  makeVoiceSession,
  MAX_QUEUED_SPEECH,
  REPLY_WINDOW,
  USER_SILENCE_TIMEOUT,
} from "./VoiceSession.ts";
import type {
  VoiceSpeechSinks,
  VoiceSynthesizerEvent,
  VoiceTranscriberEvent,
} from "./VoiceSpeechProvider.ts";

type Frame = VoiceSessionEvent | { readonly type: "audio"; readonly speechId: number };

const SENTENCE = "The build passed and I opened a pull request.";
/** 24 kHz 16-bit mono: 48 bytes a millisecond. Each character starts 40 ms after the last. */
const audio = (contextId: string, text: string, ms: number): VoiceSynthesizerEvent => ({
  type: "audio",
  contextId,
  pcm: new Uint8Array(ms * 48),
  alignment: { chars: [...text], startMs: [...text].map((_, index) => index * 40) },
});

const start = Effect.fn("test.voiceSession.start")(function* (
  dispatch: (text: string) => Effect.Effect<void, VoiceSessionError> = () => Effect.void,
) {
  const frames = yield* Queue.unbounded<Frame>();
  const dispatched = yield* Queue.unbounded<string>();
  const speech: string[] = [];
  let sinks: VoiceSpeechSinks | undefined;
  const session = yield* makeVoiceSession({
    connect: (connected) =>
      Effect.sync(() => {
        sinks = connected;
        return {
          transcriber: { send: () => Effect.void },
          synthesizer: {
            speak: (contextId, text) =>
              Effect.sync(() => void speech.push(`speak ${contextId} ${text}`)),
            cancel: (contextId) => Effect.sync(() => void speech.push(`cancel ${contextId}`)),
          },
        };
      }),
    send: (event) => Queue.offer(frames, event),
    sendAudio: (frame) =>
      Queue.offer(frames, {
        type: "audio",
        speechId: decodeVoiceSessionAudioFrame(frame)?.speechId ?? -1,
      }),
    dispatchUtterance: (text) => dispatch(text).pipe(Effect.andThen(Queue.offer(dispatched, text))),
  });
  // Every input is handled in order, so a status read returns once all earlier ones are.
  const settled = session.status;
  const hear = (event: VoiceTranscriberEvent) =>
    Effect.suspend(() => sinks!.onTranscriber(event)).pipe(Effect.andThen(settled));
  const synthesize = (event: VoiceSynthesizerEvent) =>
    Effect.suspend(() => sinks!.onSynthesizer(event)).pipe(Effect.andThen(settled));
  const next = <T extends Frame["type"]>(type: T) =>
    Queue.take(frames).pipe(
      Effect.repeat({ until: (frame) => frame.type === type }),
      Effect.map((frame) => frame as Extract<Frame, { type: T }>),
    );
  return {
    session,
    speech,
    dispatched,
    next,
    hear,
    synthesize,
    say: (text: string, priority: VoiceSayPriority = "reply") =>
      session.say(text, priority).pipe(
        Effect.forkChild({ startImmediately: true }),
        Effect.tap(() => settled),
      ),
    /** A speech with no more audio to come plays to its end. */
    finish: Effect.fn("test.voiceSession.finish")(function* (speechId: number) {
      yield* synthesize({ type: "done", contextId: `speech-${speechId}` });
      yield* TestClock.adjust("1 millis");
      return yield* next("speech_end");
    }),
    silentFrames: Queue.clear(frames),
  };
});

it.effect("barge-in stops the speech, clears playback and reports what the user heard", () =>
  Effect.gen(function* () {
    const voice = yield* start();
    const saying = yield* voice.say(SENTENCE);
    expect(yield* voice.next("speech_start")).toMatchObject({ speechId: 1, text: SENTENCE });
    yield* voice.synthesize(audio("speech-1", SENTENCE, 2000));
    expect(yield* voice.next("audio")).toEqual({ type: "audio", speechId: 1 });

    yield* voice.hear({ type: "partial", text: "wait" });
    expect(yield* voice.next("clear")).toEqual({ type: "clear", speechId: 1 });
    expect(voice.speech).toEqual([`speak speech-1 ${SENTENCE}`, "cancel speech-1"]);
    // Audio already in flight for the cut-off speech must never reach the speaker.
    yield* voice.synthesize(audio("speech-1", SENTENCE, 500));
    yield* voice.session.cleared(1, 450);

    const ended = yield* voice.next("speech_end");
    // 450 ms reaches into "passed"; a word cut off part way was not heard.
    expect(ended).toEqual({
      type: "speech_end",
      speechId: 1,
      outcome: "interrupted",
      spokenText: "The build",
    });
    expect(yield* Fiber.join(saying)).toEqual({ outcome: "interrupted", spokenText: "The build" });
    expect((yield* voice.silentFrames).filter((frame) => frame.type === "audio")).toEqual([]);
    expect(yield* voice.session.status).toMatchObject({
      speaking: null,
      lastSpoken: { outcome: "interrupted", spokenText: "The build" },
    });
  }).pipe(Effect.scoped),
);

it.effect("a client that never reports playback is judged by this server's clock", () =>
  Effect.gen(function* () {
    const voice = yield* start();
    const saying = yield* voice.say(SENTENCE);
    yield* voice.next("speech_start");
    yield* voice.synthesize(audio("speech-1", SENTENCE, 2000));
    yield* voice.next("audio");
    yield* TestClock.adjust("1 second");
    yield* voice.hear({ type: "partial", text: "hang on" });
    yield* voice.next("clear");
    yield* TestClock.adjust(CLEAR_ACK_TIMEOUT);
    expect(yield* Fiber.join(saying)).toEqual({
      outcome: "interrupted",
      spokenText: "The build passed and I",
    });
  }).pipe(Effect.scoped),
);

it.effect("listening sounds neither interrupt the bot nor reach the voice thread", () =>
  Effect.gen(function* () {
    const voice = yield* start();
    const saying = yield* voice.say(SENTENCE);
    yield* voice.next("speech_start");
    yield* voice.synthesize(audio("speech-1", SENTENCE, 2000));
    yield* voice.hear({ type: "partial", text: "Yeah" });
    yield* voice.hear({ type: "committed", text: "Yeah." });
    yield* voice.hear({ type: "committed", text: "Mm-hmm." });
    expect(yield* voice.next("transcript")).toMatchObject({ text: "Yeah", final: false });
    expect(yield* voice.next("transcript")).toMatchObject({ text: "Yeah.", final: true });

    yield* voice.synthesize({ type: "done", contextId: "speech-1" });
    yield* TestClock.adjust("2 seconds");
    expect(yield* Fiber.join(saying)).toEqual({ outcome: "delivered", spokenText: SENTENCE });
    expect(voice.speech).toEqual([`speak speech-1 ${SENTENCE}`]);
    expect(yield* Queue.size(voice.dispatched)).toBe(0);

    // Said into silence, the same word answers a question, so it goes to the voice thread.
    yield* voice.hear({ type: "committed", text: "Yeah." });
    expect(yield* Queue.take(voice.dispatched)).toBe("Yeah.");
    expect(yield* voice.next("acknowledged")).toEqual({ type: "acknowledged", text: "Yeah." });
  }).pipe(Effect.scoped),
);

it.effect("speech waits for the user, the reply goes first, and questions pass news", () =>
  Effect.gen(function* () {
    const voice = yield* start();
    yield* voice.hear({ type: "partial", text: "so about the login" });
    const news = yield* voice.say("The docs build finished.", "announcement");
    const question = yield* voice.say("Should I merge the auth fix?", "question");
    expect(voice.speech).toEqual([]);

    yield* voice.hear({ type: "committed", text: "So about the login page, is it done?" });
    expect(yield* Queue.take(voice.dispatched)).toBe("So about the login page, is it done?");
    // The user is waiting on an answer, so news and questions stay behind it.
    expect(voice.speech).toEqual([]);
    yield* voice.say("Yes, it shipped an hour ago.");
    expect(yield* voice.next("speech_start")).toMatchObject({ priority: "reply" });
    yield* voice.finish(1);
    expect(yield* voice.next("speech_start")).toMatchObject({ priority: "question" });
    yield* voice.finish(2);
    expect(yield* voice.next("speech_start")).toMatchObject({ priority: "announcement" });
    yield* voice.finish(3);
    expect(yield* Fiber.join(question)).toMatchObject({ outcome: "delivered" });
    expect(yield* Fiber.join(news)).toMatchObject({ outcome: "delivered" });
  }).pipe(Effect.scoped),
);

it.effect("held speech tells its caller, and is released when the hold ends", () =>
  Effect.gen(function* () {
    const voice = yield* start();
    yield* voice.hear({ type: "committed", text: "Quiet." });
    expect(yield* voice.next("local_command")).toEqual({ type: "local_command", command: "quiet" });
    const news = yield* voice.say("The docs build finished.", "announcement");
    yield* TestClock.adjust(HELD_REPORT_DELAY);
    expect(yield* Fiber.join(news)).toEqual({ outcome: "held", spokenText: "" });
    expect(yield* voice.session.status).toMatchObject({ quiet: true, queued: 1 });
    // A reply to the user is never held by quiet.
    yield* voice.say("Okay.");
    expect(yield* voice.next("speech_start")).toMatchObject({ text: "Okay." });
    yield* voice.finish(1);

    yield* voice.hear({ type: "committed", text: "Go ahead." });
    expect(yield* voice.next("speech_start")).toMatchObject({ text: "The docs build finished." });
    expect(yield* Queue.size(voice.dispatched)).toBe(0);

    // A user who trails off without finishing a turn does not hold speech forever.
    yield* voice.finish(2);
    yield* voice.hear({ type: "partial", text: "um so" });
    yield* voice.say("Tests are green.", "announcement");
    yield* TestClock.adjust(USER_SILENCE_TIMEOUT);
    expect(yield* voice.next("speech_start")).toMatchObject({ text: "Tests are green." });
  }).pipe(Effect.scoped),
);

it.effect("news stops waiting for a reply that never comes", () =>
  Effect.gen(function* () {
    const voice = yield* start();
    yield* voice.hear({ type: "committed", text: "Start the migration." });
    yield* voice.next("acknowledged");
    yield* voice.say("The docs build finished.", "announcement");
    expect(voice.speech).toEqual([]);
    yield* TestClock.adjust(REPLY_WINDOW);
    expect(yield* voice.next("speech_start")).toMatchObject({ priority: "announcement" });
  }).pipe(Effect.scoped),
);

it.effect("stop and repeat are handled here, without the voice thread", () =>
  Effect.gen(function* () {
    const voice = yield* start();
    const saying = yield* voice.say(SENTENCE);
    yield* voice.next("speech_start");
    yield* voice.synthesize(audio("speech-1", SENTENCE, 2000));
    const queued = yield* voice.say("And the docs build finished.", "announcement");

    yield* voice.hear({ type: "committed", text: "Stop." });
    expect(yield* voice.next("local_command")).toEqual({ type: "local_command", command: "stop" });
    yield* voice.session.cleared(1, 0);
    expect(yield* Fiber.join(saying)).toEqual({ outcome: "interrupted", spokenText: "" });
    // Stop also drops what was waiting, so the next thing said is not stale news.
    expect(yield* Fiber.join(queued)).toEqual({ outcome: "interrupted", spokenText: "" });

    yield* voice.hear({ type: "committed", text: "Say that again?" });
    expect(yield* voice.next("speech_start")).toMatchObject({ speechId: 2, text: SENTENCE });
    expect(yield* Queue.size(voice.dispatched)).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("speech ends when its audio stops, even if the speech service never says so", () =>
  Effect.gen(function* () {
    const voice = yield* start();
    const saying = yield* voice.say("Done.");
    yield* voice.next("speech_start");
    yield* voice.synthesize(audio("speech-1", "Done.", 300));
    yield* voice.next("audio");
    yield* TestClock.adjust(AUDIO_IDLE_TIMEOUT);
    expect(yield* Fiber.join(saying)).toEqual({ outcome: "delivered", spokenText: "Done." });
  }).pipe(Effect.scoped),
);

it.effect("refuses more speech than the user could sit through", () =>
  Effect.gen(function* () {
    const voice = yield* start();
    yield* voice.hear({ type: "partial", text: "let me think" });
    yield* Effect.forEach(
      Array.from({ length: MAX_QUEUED_SPEECH }),
      () => voice.say("One more thing.", "announcement"),
      { discard: true },
    );
    const refused = yield* Effect.flip(voice.session.say("Too much.", "announcement"));
    expect(refused._tag).toBe("VoiceSpeechQueueFullError");
  }).pipe(Effect.scoped),
);

it.effect(
  "a turn the voice thread cannot take is reported, and a dead speech link ends the conversation",
  () =>
    Effect.gen(function* () {
      const voice = yield* start(() =>
        Effect.fail(new VoiceSessionError({ reason: "router-unavailable" })),
      );
      yield* voice.hear({ type: "committed", text: "Start the migration." });
      expect(yield* voice.next("error")).toMatchObject({ reason: "router-unavailable" });
      // Nothing is coming back, so news is not held for a reply.
      yield* voice.say("The docs build finished.", "announcement");
      expect(yield* voice.next("speech_start")).toMatchObject({ priority: "announcement" });

      yield* voice.hear({ type: "failed", reason: "rate-limit" });
      expect(yield* voice.session.failed).toBe("rate-limit");
    }).pipe(Effect.scoped),
);
