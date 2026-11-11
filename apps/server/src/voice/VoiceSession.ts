import {
  encodeVoiceSessionAudioFrame,
  VOICE_SESSION_OUTPUT_SAMPLE_RATE,
  VoiceSessionError,
  type VoiceHealthEntry,
  type VoiceLocalCommand,
  type VoiceSayPriority,
  type VoiceSayResult,
  type VoiceSessionErrorReason,
  type VoiceSessionEvent,
  type VoiceStatusResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  classifyVoiceTurn,
  interruptsSpeech,
  type SpokenMark,
  spokenTextAt,
} from "./turnFilter.ts";
import type {
  VoiceAudioAlignment,
  VoiceSpeechConnection,
  VoiceSpeechSinks,
  VoiceSynthesizerEvent,
  VoiceTranscriberEvent,
} from "./VoiceSpeechProvider.ts";

/** Without transcript updates for this long, the user has stopped talking without a turn. */
export const USER_SILENCE_TIMEOUT = Duration.seconds(3);
/** News waits this long for the reply to what the user just said, so it does not cut in first. */
export const REPLY_WINDOW = Duration.seconds(8);
/** How long the client has to say how much of an interrupted speech it played. */
export const CLEAR_ACK_TIMEOUT = Duration.millis(400);
/** A caller waiting on queued speech is told `held` after this long, and the speech stays queued. */
export const HELD_REPORT_DELAY = Duration.seconds(4);
export const FIRST_AUDIO_TIMEOUT = Duration.seconds(10);
/** Audio that stops arriving has ended, whether or not the speech service says so. */
export const AUDIO_IDLE_TIMEOUT = Duration.seconds(2);
export const MAX_QUEUED_SPEECH = 8;

const PRIORITY_RANK: Record<VoiceSayPriority, number> = { reply: 0, question: 1, announcement: 2 };
const MS_PER_BYTE = 1000 / (VOICE_SESSION_OUTPUT_SAMPLE_RATE * 2);

export class VoiceSpeechQueueFullError extends Schema.TaggedError<VoiceSpeechQueueFullError>()(
  "VoiceSpeechQueueFullError",
  {},
) {
  override get message(): string {
    return "Too much is already waiting to be said. Wait for the user to hear it, then try again.";
  }
}

interface SpeechItem {
  readonly id: number;
  readonly text: string;
  readonly priority: VoiceSayPriority;
  readonly result: Deferred.Deferred<VoiceSayResult>;
}

interface ActiveSpeech {
  readonly item: SpeechItem;
  readonly speechId: number;
  readonly contextId: string;
  readonly marks: Array<SpokenMark>;
  startedAt: number | undefined;
  audioMs: number;
  synthesized: boolean;
  /** Set once the speech is cut off: how much had played by this server's clock. */
  clearing: { readonly estimateMs: number } | undefined;
}

type TimerKey =
  | "userSilence"
  | "replyWindow"
  | "clearAck"
  | "playbackDone"
  | "firstAudio"
  | "audioIdle";

type Input =
  | { readonly type: "transcriber"; readonly event: VoiceTranscriberEvent }
  | { readonly type: "synthesizer"; readonly event: VoiceSynthesizerEvent }
  | {
      readonly type: "say";
      readonly item: SpeechItem;
      readonly accepted: Deferred.Deferred<boolean>;
      readonly onAccepted: (() => void) | undefined;
    }
  | { readonly type: "cleared"; readonly speechId: number; readonly playedMs: number }
  | { readonly type: "timer"; readonly key: TimerKey }
  | { readonly type: "held"; readonly itemId: number }
  | { readonly type: "dispatchFailed"; readonly reason: VoiceSessionErrorReason }
  | { readonly type: "status"; readonly reply: Deferred.Deferred<SessionStatus> };

type SessionStatus = Omit<VoiceStatusResult, "active" | "routerThreadId">;

export interface VoiceSessionOptions {
  /** Opens the speech connections. What they report is handled in the order it arrives. */
  readonly connect: (
    sinks: VoiceSpeechSinks,
  ) => Effect.Effect<VoiceSpeechConnection, VoiceSessionError, Scope.Scope>;
  readonly send: (event: VoiceSessionEvent) => Effect.Effect<void>;
  readonly sendAudio: (frame: Uint8Array) => Effect.Effect<void>;
  /** Told of each failure a watchdog should know about. */
  readonly onHealth?: (kind: VoiceHealthEntry["kind"]) => Effect.Effect<void>;
  /** Hands one finished user turn to the voice thread. */
  readonly dispatchUtterance: (text: string) => Effect.Effect<void, VoiceSessionError>;
}

export interface VoiceSession {
  readonly feedAudio: (pcm: Uint8Array) => Effect.Effect<void>;
  /** The client reports how much of an interrupted speech it played. */
  readonly cleared: (speechId: number, playedMs: number) => Effect.Effect<void>;
  /** `onAccepted` runs as the speech joins the queue, before anything else can observe it. */
  readonly say: (
    text: string,
    priority: VoiceSayPriority,
    onAccepted?: () => void,
  ) => Effect.Effect<VoiceSayResult, VoiceSpeechQueueFullError>;
  readonly status: Effect.Effect<SessionStatus>;
  /** Completes when a speech connection fails; the conversation cannot continue. */
  readonly failed: Effect.Effect<VoiceSessionErrorReason>;
}

/**
 * One live conversation. Audio flows both ways the whole time: the user can cut the bot off
 * mid-sentence, and the bot can speak whenever the voice thread asks, held only while the user
 * is talking. One fiber owns all the state, so every input is handled in arrival order.
 */
export const makeVoiceSession = Effect.fn("VoiceSession.make")(function* (
  options: VoiceSessionOptions,
) {
  const scope = yield* Scope.Scope;
  const inbox = yield* Queue.unbounded<Input>();
  const utterances = yield* Queue.unbounded<string>();
  const failure = yield* Deferred.make<VoiceSessionErrorReason>();
  const { transcriber, synthesizer } = yield* options.connect({
    onTranscriber: (event) => Queue.offer(inbox, { type: "transcriber", event }),
    onSynthesizer: (event) => Queue.offer(inbox, { type: "synthesizer", event }),
  });
  const timers = new Map<string, Fiber.Fiber<unknown>>();
  const queue: Array<SpeechItem> = [];
  let current: ActiveSpeech | undefined;
  let userSpeaking = false;
  let turnBeganOverSpeech = false;
  let quiet = false;
  let awaitingReply = false;
  let itemCounter = 0;
  let speechCounter = 0;
  let lastHeard: string | null = null;
  let lastSaid: string | undefined;
  let lastSpoken: SessionStatus["lastSpoken"] = null;
  let reported = { userSpeaking: false, quiet: false, queued: 0 };

  const noteHealth = (kind: VoiceHealthEntry["kind"]) => options.onHealth?.(kind) ?? Effect.void;
  const failWith = (reason: VoiceSessionErrorReason) =>
    noteHealth(reason).pipe(Effect.andThen(Deferred.succeed(failure, reason)));

  const cancelTimer = (key: string) =>
    Effect.suspend(() => {
      const fiber = timers.get(key);
      timers.delete(key);
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
    });
  const setTimer = (key: string, delay: Duration.Input, input: Input) =>
    cancelTimer(key).pipe(
      Effect.andThen(
        Effect.sleep(delay).pipe(Effect.andThen(Queue.offer(inbox, input)), Effect.forkIn(scope)),
      ),
      Effect.map((fiber) => void timers.set(key, fiber)),
    );
  const timer = (key: TimerKey, delay: Duration.Input) =>
    setTimer(key, delay, { type: "timer", key });

  const settle = (item: SpeechItem, outcome: "delivered" | "interrupted", spokenText: string) =>
    cancelTimer(`held:${item.id}`).pipe(
      Effect.andThen(Deferred.succeed(item.result, { outcome, spokenText })),
    );

  const finish = Effect.fnUntraced(function* (
    outcome: "delivered" | "interrupted",
    spokenText: string,
  ) {
    const speech = current;
    if (speech === undefined) return;
    current = undefined;
    yield* Effect.forEach(["clearAck", "playbackDone", "firstAudio", "audioIdle"], cancelTimer, {
      discard: true,
    });
    lastSpoken = { outcome, spokenText };
    if (speech.item.priority === "reply") {
      awaitingReply = false;
      yield* cancelTimer("replyWindow");
    }
    yield* options.send({ type: "speech_end", speechId: speech.speechId, outcome, spokenText });
    yield* settle(speech.item, outcome, spokenText);
  });

  const heardBy = (speech: ActiveSpeech, playedMs: number) =>
    speech.synthesized && playedMs >= speech.audioMs
      ? speech.item.text.trim()
      : spokenTextAt(speech.item.text, speech.marks, playedMs);

  /** Barge-in: stop the speech at its source and at the speaker, then learn what was heard. */
  const interrupt = Effect.fnUntraced(function* () {
    const speech = current;
    if (speech === undefined || speech.clearing !== undefined) return;
    const now = yield* Clock.currentTimeMillis;
    speech.clearing = {
      estimateMs:
        speech.startedAt === undefined ? 0 : Math.min(speech.audioMs, now - speech.startedAt),
    };
    yield* Effect.forEach(["playbackDone", "firstAudio", "audioIdle"], cancelTimer, {
      discard: true,
    });
    yield* synthesizer.cancel(speech.contextId);
    yield* options.send({ type: "clear", speechId: speech.speechId });
    yield* timer("clearAck", CLEAR_ACK_TIMEOUT);
  });

  const discardQueued = Effect.fnUntraced(function* () {
    for (const item of queue.splice(0)) yield* settle(item, "interrupted", "");
  });

  const enqueue = (item: SpeechItem) => {
    const rank = PRIORITY_RANK[item.priority];
    const index = queue.findIndex((queued) => PRIORITY_RANK[queued.priority] > rank);
    queue.splice(index === -1 ? queue.length : index, 0, item);
  };

  const addSpeech = (text: string, priority: VoiceSayPriority) =>
    Deferred.make<VoiceSayResult>().pipe(
      Effect.map((result): SpeechItem => ({ id: ++itemCounter, text, priority, result })),
      Effect.tap((item) => Effect.sync(() => enqueue(item))),
    );

  const startNext = Effect.fnUntraced(function* () {
    if (current !== undefined || userSpeaking) return;
    const index = queue.findIndex(
      (item) => item.priority === "reply" || (!quiet && !awaitingReply),
    );
    if (index === -1) return;
    const [item] = queue.splice(index, 1);
    if (item === undefined) return;
    const speechId = ++speechCounter;
    current = {
      item,
      speechId,
      contextId: `speech-${speechId}`,
      marks: [],
      startedAt: undefined,
      audioMs: 0,
      synthesized: false,
      clearing: undefined,
    };
    lastSaid = item.text;
    yield* cancelTimer(`held:${item.id}`);
    yield* options.send({
      type: "speech_start",
      speechId,
      priority: item.priority,
      text: item.text,
    });
    yield* synthesizer.speak(current.contextId, item.text);
    yield* timer("firstAudio", FIRST_AUDIO_TIMEOUT);
  });

  const addMarks = (speech: ActiveSpeech, alignment: VoiceAudioAlignment | undefined) => {
    if (alignment === undefined) return;
    alignment.chars.forEach((char, index) => {
      speech.marks.push({ char, atMs: speech.audioMs + (alignment.startMs[index] ?? 0) });
    });
  };

  const synthesized = Effect.fnUntraced(function* (speech: ActiveSpeech, now: number) {
    speech.synthesized = true;
    yield* cancelTimer("firstAudio");
    yield* cancelTimer("audioIdle");
    const remaining = speech.startedAt === undefined ? 0 : speech.startedAt + speech.audioMs - now;
    yield* timer("playbackDone", Duration.millis(Math.max(0, remaining)));
  });

  const onSynthesizer = Effect.fnUntraced(function* (event: VoiceSynthesizerEvent) {
    if (event.type === "failed") return yield* failWith(event.reason);
    const speech = current;
    if (speech === undefined || speech.contextId !== event.contextId || speech.clearing) return;
    const now = yield* Clock.currentTimeMillis;
    if (event.type === "audio") {
      if (speech.startedAt === undefined) {
        speech.startedAt = now;
        yield* cancelTimer("firstAudio");
      }
      addMarks(speech, event.alignment);
      speech.audioMs += event.pcm.byteLength * MS_PER_BYTE;
      yield* timer("audioIdle", AUDIO_IDLE_TIMEOUT);
      return yield* options.sendAudio(encodeVoiceSessionAudioFrame(speech.speechId, event.pcm));
    }
    yield* synthesized(speech, now);
  });

  const runCommand = Effect.fnUntraced(function* (command: VoiceLocalCommand) {
    yield* options.send({ type: "local_command", command });
    switch (command) {
      case "stop":
        yield* discardQueued();
        return yield* interrupt();
      case "quiet":
        quiet = true;
        return yield* interrupt();
      case "resume":
        quiet = false;
        return;
      case "repeat":
        if (lastSaid !== undefined) yield* addSpeech(lastSaid, "reply");
        return;
      case "louder":
      case "quieter":
        return;
    }
  });

  const onTranscriber = Effect.fnUntraced(function* (event: VoiceTranscriberEvent) {
    if (event.type === "failed") return yield* failWith(event.reason);
    if (event.type === "partial") {
      if (event.text.trim().length === 0) return;
      const speaking = current !== undefined && current.clearing === undefined;
      if (!userSpeaking) turnBeganOverSpeech = speaking;
      userSpeaking = true;
      yield* timer("userSilence", USER_SILENCE_TIMEOUT);
      yield* options.send({ type: "transcript", text: event.text, final: false });
      if (speaking && interruptsSpeech(event.text)) yield* interrupt();
      return;
    }
    const overSpeech =
      turnBeganOverSpeech || (current !== undefined && current.clearing === undefined);
    userSpeaking = false;
    turnBeganOverSpeech = false;
    yield* cancelTimer("userSilence");
    const turn = classifyVoiceTurn(event.text, overSpeech);
    if (turn.kind === "noise") return;
    yield* options.send({ type: "transcript", text: event.text.trim(), final: true });
    if (turn.kind === "backchannel") return;
    if (turn.kind === "command") return yield* runCommand(turn.command);
    // A commit can arrive with no partial before it, so the bot may still be mid-sentence.
    yield* interrupt();
    lastHeard = turn.text;
    awaitingReply = true;
    yield* timer("replyWindow", REPLY_WINDOW);
    yield* options.send({ type: "acknowledged", text: turn.text });
    yield* Queue.offer(utterances, turn.text);
  });

  const onTimer = Effect.fnUntraced(function* (key: TimerKey) {
    timers.delete(key);
    switch (key) {
      case "userSilence":
        userSpeaking = false;
        turnBeganOverSpeech = false;
        return;
      case "replyWindow":
        awaitingReply = false;
        return;
      case "playbackDone":
        return yield* finish("delivered", current?.item.text.trim() ?? "");
      case "clearAck":
        if (current?.clearing === undefined) return;
        return yield* finish("interrupted", heardBy(current, current.clearing.estimateMs));
      case "audioIdle":
        if (current === undefined || current.clearing) return;
        return yield* synthesized(current, yield* Clock.currentTimeMillis);
      case "firstAudio":
        if (current === undefined) return;
        yield* noteHealth("first-audio-timeout");
        yield* synthesizer.cancel(current.contextId);
        return yield* finish("interrupted", "");
    }
  });

  const snapshot = (): SessionStatus => ({
    userSpeaking,
    quiet,
    speaking: current === undefined || current.clearing ? null : current.item.text,
    queued: queue.length,
    lastHeard,
    lastSpoken,
  });

  const handle = Effect.fnUntraced(function* (input: Input) {
    switch (input.type) {
      case "transcriber":
        yield* onTranscriber(input.event);
        break;
      case "synthesizer":
        yield* onSynthesizer(input.event);
        break;
      case "say":
        if (queue.length >= MAX_QUEUED_SPEECH) {
          yield* Deferred.succeed(input.accepted, false);
          break;
        }
        enqueue(input.item);
        input.onAccepted?.();
        yield* Deferred.succeed(input.accepted, true);
        yield* setTimer(`held:${input.item.id}`, HELD_REPORT_DELAY, {
          type: "held",
          itemId: input.item.id,
        });
        break;
      case "held": {
        timers.delete(`held:${input.itemId}`);
        const item = queue.find((queued) => queued.id === input.itemId);
        if (item)
          yield* Deferred.succeed(item.result, { outcome: "held" as const, spokenText: "" });
        break;
      }
      case "cleared": {
        const speech = current;
        if (speech?.clearing === undefined || speech.speechId !== input.speechId) break;
        const playedMs = Math.min(input.playedMs, speech.audioMs);
        yield* finish(
          speech.synthesized && playedMs >= speech.audioMs ? "delivered" : "interrupted",
          heardBy(speech, playedMs),
        );
        break;
      }
      case "timer":
        yield* onTimer(input.key);
        break;
      case "dispatchFailed":
        yield* noteHealth(input.reason);
        awaitingReply = false;
        yield* cancelTimer("replyWindow");
        yield* options.send({
          type: "error",
          reason: input.reason,
          message: new VoiceSessionError({ reason: input.reason }).message,
        });
        break;
      case "status":
        yield* Deferred.succeed(input.reply, snapshot());
        return;
    }
    yield* startNext();
    const queued = queue.length;
    if (
      reported.userSpeaking !== userSpeaking ||
      reported.quiet !== quiet ||
      reported.queued !== queued
    ) {
      reported = { userSpeaking, quiet, queued };
      yield* options.send({ type: "status", ...reported });
    }
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (current !== undefined) {
        yield* synthesizer.cancel(current.contextId);
        yield* settle(current.item, "interrupted", "");
      }
      yield* discardQueued();
    }),
  );
  // Turns reach the voice thread one at a time and in order, without stalling audio handling.
  yield* Effect.forever(
    Queue.take(utterances).pipe(
      Effect.flatMap(options.dispatchUtterance),
      Effect.catch((error) => Queue.offer(inbox, { type: "dispatchFailed", reason: error.reason })),
    ),
  ).pipe(Effect.forkIn(scope));
  yield* Effect.forever(Queue.take(inbox).pipe(Effect.flatMap(handle))).pipe(Effect.forkIn(scope));

  const say: VoiceSession["say"] = Effect.fn("VoiceSession.say")(
    function* (text, priority, onAccepted) {
      const item: SpeechItem = {
        id: ++itemCounter,
        text,
        priority,
        result: yield* Deferred.make<VoiceSayResult>(),
      };
      const accepted = yield* Deferred.make<boolean>();
      yield* Queue.offer(inbox, { type: "say", item, accepted, onAccepted });
      if (!(yield* Deferred.await(accepted))) return yield* new VoiceSpeechQueueFullError();
      return yield* Deferred.await(item.result);
    },
  );

  return {
    feedAudio: transcriber.send,
    cleared: (speechId, playedMs) =>
      Queue.offer(inbox, { type: "cleared", speechId, playedMs }).pipe(Effect.asVoid),
    say,
    status: Deferred.make<SessionStatus>().pipe(
      Effect.tap((reply) => Queue.offer(inbox, { type: "status", reply })),
      Effect.flatMap(Deferred.await),
    ),
    failed: Deferred.await(failure),
  } satisfies VoiceSession;
});
