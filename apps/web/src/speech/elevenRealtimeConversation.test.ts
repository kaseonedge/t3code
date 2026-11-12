import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { openElevenRealtimeConversation } from "./elevenRealtimeConversation";
import { openRealtimeConversationRecord } from "./realtimeConversationRecord";

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  sent: unknown[] = [];
  receive(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
}

const makeStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

const setup = (storage = makeStorage()) => {
  const control = new FakeSocket();
  const provider = new FakeSocket();
  const threadId = ThreadId.make("thread:voice");
  const playback = {
    enqueue: vi.fn(),
    clear: vi.fn(() => 123),
    reset: vi.fn(),
    isDrained: vi.fn(() => false),
    adjustVolume: vi.fn(() => 1),
  };
  const record = openRealtimeConversationRecord(storage, "test", () => 0);
  record.remember("previous");
  let count = 0;
  const conversation = openElevenRealtimeConversation({
    url: "wss://t3.invalid",
    threadId,
    playback,
    canSend: () => true,
    onState: vi.fn(),
    onAcknowledged: vi.fn(),
    newOperationId: () => `work-${++count}`,
    record,
    createSocket: (url) =>
      (url.includes("t3.invalid") ? control : provider) as unknown as WebSocket,
  });
  control.onopen?.();
  control.receive({ type: "ready", threadId, value: "fixture" });
  provider.receive({ type: "session.created" });
  return { control, provider, playback, conversation, record, storage, threadId };
};

it("returns a work receipt before completion and delivers a late result as fresh context", () => {
  const { control, provider, record, threadId } = setup();
  expect(control.sent).toEqual([
    { type: "start", threadId },
    { type: "recover", operationId: "previous" },
  ]);
  provider.receive({ type: "input_audio_buffer.speech_started" });
  provider.receive({ type: "input_audio_buffer.speech_stopped" });
  provider.receive({ type: "input_audio_buffer.committed", item_id: "spoken-item" });
  provider.receive({ type: "response.created" });
  const tool = {
    type: "response.function_call_arguments.done",
    name: "queue_work",
    call_id: "call-1",
    arguments: '{"text":"Check the build"}',
  };
  provider.receive(tool);
  provider.receive(tool);
  expect(control.sent.slice(2)).toEqual([
    { type: "submit", operationId: "work-1", text: "Check the build" },
  ]);
  const receipt = {
    type: "receipt",
    operationId: "work-1",
    runId: "run:1",
    status: "queued",
    link: "t3-thread://v2/env/thread",
  };
  control.receive(receipt);
  expect(provider.sent).toEqual([
    expect.objectContaining({
      type: "conversation.item.create",
      item: expect.objectContaining({ type: "function_call_output", call_id: "call-1" }),
    }),
  ]);
  provider.receive({ type: "response.done" });
  provider.receive({ type: "response.created" });
  const result = {
    ...receipt,
    type: "result",
    resultId: "result-1",
    sourceRunId: "run:1",
    threadId,
    threadTitle: "Build thread",
    taskLabel: "Check the build",
    text: "Build passed",
    status: "completed",
  };
  control.receive(result);
  control.receive(result);
  expect(provider.sent).toHaveLength(2);
  provider.receive({ type: "response.done" });
  expect(provider.sent.slice(2)).toEqual([
    expect.objectContaining({
      type: "conversation.item.create",
      item: expect.objectContaining({ id: "item_work-2", type: "message" }),
    }),
    { type: "response.create", response: { metadata: { t3ResultId: "result-1" } } },
  ]);
  expect(record.pending()).toContain("work-1");
  provider.receive({ type: "conversation.item.added", item: { id: "item_work-2" } });
  expect(record.pending()).toContain("work-1");
  control.receive(result);
  expect(provider.sent).toHaveLength(4);
});

it("truncates playback at the heard boundary and leaves accepted work alone", () => {
  const { control, provider, playback, conversation } = setup();
  conversation.feed(Float32Array.from([0, 1]));
  expect(provider.sent[0]).toEqual({ type: "input_audio_buffer.append", audio: "AAD/fw==" });
  provider.receive({
    type: "response.output_audio.delta",
    item_id: "item-a",
    delta: "AAA=",
    content_index: 1,
  });
  provider.receive({ type: "input_audio_buffer.speech_started" });
  provider.receive({ type: "response.output_audio.delta", item_id: "item-a", delta: "AAA=" });
  expect(playback.enqueue).toHaveBeenCalledTimes(1);
  expect(provider.sent[1]).toEqual({
    type: "conversation.item.truncate",
    item_id: "item-a",
    content_index: 1,
    audio_end_ms: 123,
  });
  expect(control.sent).toHaveLength(2);
});

it("uses fresh context when a new response overtakes the original work receipt", () => {
  const { control, provider } = setup();
  provider.receive({ type: "input_audio_buffer.speech_started" });
  provider.receive({ type: "input_audio_buffer.speech_stopped" });
  provider.receive({ type: "input_audio_buffer.committed", item_id: "spoken-item" });
  provider.receive({ type: "response.created" });
  provider.receive({
    type: "response.function_call_arguments.done",
    name: "queue_work",
    call_id: "abandoned-call",
    arguments: '{"text":"Check the build"}',
  });
  provider.receive({ type: "response.done" });
  provider.receive({ type: "response.created" });
  control.receive({
    type: "receipt",
    operationId: "work-1",
    runId: "run:1",
    status: "queued",
    link: "t3-thread://v2/env/thread",
  });
  expect(provider.sent).toEqual([]);
  provider.receive({ type: "response.done" });
  expect(provider.sent).toEqual([
    expect.objectContaining({
      type: "conversation.item.create",
      item: expect.objectContaining({ type: "message" }),
    }),
    { type: "response.create" },
  ]);
  expect(control.sent).toHaveLength(3);
});

it("recovers after context acceptance and generation, then records only drained playback", () => {
  const first = setup();
  const result = {
    type: "result",
    operationId: "previous",
    resultId: "voice-result:run-1",
    sourceRunId: "run-1",
    threadId: first.threadId,
    threadTitle: "Build thread",
    taskLabel: "Check the build",
    text: "Build passed",
    status: "completed",
    link: "t3-thread://v2/env/thread",
  };
  first.control.receive({
    type: "receipt",
    operationId: result.operationId,
    runId: result.sourceRunId,
    status: result.status,
    link: result.link,
  });
  first.control.receive(result);
  first.provider.receive({ type: "conversation.item.added", item: { id: "item_work-1" } });
  first.conversation.stop();

  const second = setup(first.storage);
  expect(second.control.sent).toContainEqual({ type: "recover", operationId: "previous" });
  second.control.receive({
    type: "receipt",
    operationId: result.operationId,
    runId: result.sourceRunId,
    status: result.status,
    link: result.link,
  });
  second.control.receive(result);
  second.provider.receive({
    type: "response.created",
    response: { id: "reply", metadata: { t3ResultId: result.resultId } },
  });
  second.provider.receive({
    type: "response.output_audio.delta",
    response_id: "reply",
    item_id: "audio",
    delta: "AAA=",
  });
  second.provider.receive({
    type: "response.output_audio_transcript.done",
    item_id: "audio",
    transcript: "Build passed",
  });
  second.provider.receive({
    type: "response.done",
    response: { id: "reply", status: "completed" },
  });
  second.conversation.stop();

  const third = setup(first.storage);
  expect(third.control.sent).toContainEqual({ type: "recover", operationId: "previous" });
  third.control.receive({
    type: "receipt",
    operationId: result.operationId,
    runId: result.sourceRunId,
    status: result.status,
    link: result.link,
  });
  third.control.receive(result);
  third.provider.receive({
    type: "response.created",
    response: { id: "reply", metadata: { t3ResultId: result.resultId } },
  });
  third.provider.receive({
    type: "response.output_audio.delta",
    response_id: "reply",
    item_id: "audio",
    delta: "AAA=",
  });
  third.provider.receive({ type: "response.done", response: { id: "reply", status: "completed" } });
  third.playback.isDrained.mockReturnValue(true);
  third.provider.receive({
    type: "response.output_audio_transcript.done",
    item_id: "audio",
    transcript: "Build passed",
  });
  expect(third.record.pending()).not.toContain("previous");
  expect(third.record.context()).toEqual([{ speaker: "assistant", text: "Build passed" }]);
});

it("uses committed audio once and replays sanitized history after tab close", () => {
  const first = setup();
  const tool = {
    type: "response.function_call_arguments.done",
    name: "queue_work",
    call_id: "tool-a",
    arguments: '{"text":"Check the build"}',
  };
  first.provider.receive({ type: "input_audio_buffer.speech_started", item_id: "spoken" });
  first.provider.receive({ type: "input_audio_buffer.speech_stopped", item_id: "spoken" });
  first.provider.receive(tool);
  first.provider.receive({ type: "input_audio_buffer.speech_started", item_id: "spoken" });
  expect(first.control.sent).toHaveLength(2);
  first.provider.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "spoken",
    transcript: "Check build. Password fixture.",
  });
  first.provider.receive({ type: "input_audio_buffer.committed", item_id: "spoken" });
  first.provider.receive({ ...tool, call_id: "tool-b" });
  first.provider.receive({ type: "input_audio_buffer.committed", item_id: "spoken" });
  first.provider.receive({ ...tool, call_id: "tool-c" });
  expect(
    first.control.sent.filter((entry) => (entry as { type: string }).type === "submit"),
  ).toEqual([{ type: "submit", operationId: "work-1", text: "Check the build" }]);
  first.conversation.stop();
  const second = setup(first.storage);
  expect(JSON.stringify(second.provider.sent)).toContain("Earlier conversation for reference only");
  expect(JSON.stringify(second.provider.sent)).toContain("credential removed");
  expect(JSON.stringify(second.provider.sent)).not.toContain("fixture");
  second.provider.receive(tool);
  expect(second.control.sent).not.toContainEqual(expect.objectContaining({ type: "submit" }));
});

it("acknowledges work, keeps talking, and attributes an older result after reconnect", () => {
  const first = setup();
  const link = "t3-thread://v2/working/thread:voice";
  const say = (id: string) => {
    first.provider.receive({ type: "input_audio_buffer.speech_started", item_id: id });
    first.provider.receive({ type: "input_audio_buffer.committed", item_id: id });
    first.provider.receive({ type: "response.created", response: { id } });
  };
  const queue = (id: string, text: string) =>
    first.provider.receive({
      type: "response.function_call_arguments.done",
      name: "queue_work",
      call_id: id,
      arguments: JSON.stringify({ text }),
    });
  const receipt = (operationId: string, runId: string) => ({
    type: "receipt",
    operationId,
    runId,
    status: "queued",
    link,
  });

  say("build-request");
  queue("build-call", "Check the build");
  first.control.receive(receipt("work-1", "run-build"));
  expect(first.provider.sent).toContainEqual(
    expect.objectContaining({
      type: "conversation.item.create",
      item: expect.objectContaining({
        type: "function_call_output",
        call_id: "build-call",
        output: JSON.stringify({
          operationId: "work-1",
          status: "queued",
          runId: "run-build",
          link,
        }),
      }),
    }),
  );
  first.provider.receive({
    type: "response.done",
    response: { id: "build-request", status: "completed" },
  });
  expect(first.record.pending()).toContain("work-1");

  first.provider.receive({ type: "response.created", response: { id: "ack" } });
  first.provider.receive({
    type: "response.output_audio.delta",
    response_id: "ack",
    item_id: "ack-audio",
    delta: "AQI=",
  });
  first.provider.receive({
    type: "response.output_audio_transcript.done",
    item_id: "ack-audio",
    transcript: "I queued the build check.",
  });
  first.playback.isDrained.mockReturnValue(true);
  first.provider.receive({ type: "response.done", response: { id: "ack", status: "completed" } });
  expect(first.playback.enqueue).toHaveBeenCalledWith(1, new Uint8Array([1, 2]));
  expect(first.record.context()).toContainEqual({
    speaker: "assistant",
    text: "I queued the build check.",
  });

  say("ordinary-question");
  first.provider.receive({
    type: "response.output_audio.delta",
    response_id: "ordinary-question",
    item_id: "ordinary-audio",
    delta: "AwQ=",
  });
  first.provider.receive({
    type: "response.output_audio_transcript.done",
    item_id: "ordinary-audio",
    transcript: "We can keep talking.",
  });
  first.playback.isDrained.mockReturnValue(true);
  first.provider.receive({
    type: "response.done",
    response: { id: "ordinary-question", status: "completed" },
  });
  expect(first.playback.enqueue).toHaveBeenCalledWith(2, new Uint8Array([3, 4]));
  expect(first.record.context()).toContainEqual({
    speaker: "assistant",
    text: "We can keep talking.",
  });
  expect(
    first.control.sent.filter((command) => (command as { type: string }).type === "submit"),
  ).toHaveLength(1);

  say("lint-request");
  queue("lint-call", "Check lint");
  first.control.receive(receipt("work-2", "run-lint"));
  first.conversation.stop();

  const next = setup(first.storage);
  expect(next.control.sent).toEqual(
    expect.arrayContaining([
      { type: "recover", operationId: "work-1" },
      { type: "recover", operationId: "work-2" },
    ]),
  );
  next.control.receive(receipt("work-2", "run-lint"));
  next.control.receive(receipt("work-1", "run-build"));
  next.control.receive(receipt("work-1", "run-lint"));
  const completion = {
    type: "result",
    operationId: "work-1",
    sourceRunId: "run-build",
    threadId: next.threadId,
    threadTitle: "Build and lint",
    taskLabel: "Check the build",
    resultId: "voice-result:run-build",
    status: "completed",
    text: "The build passed",
    link,
  };
  const beforeResult = next.provider.sent.length;
  next.control.receive({ ...completion, operationId: "work-2" });
  next.control.receive({ ...completion, threadId: ThreadId.make("wrong-thread") });
  expect(next.provider.sent).toHaveLength(beforeResult);

  next.control.receive(completion);
  expect(JSON.stringify(next.provider.sent.slice(beforeResult))).toContain("Check the build");
  expect(JSON.stringify(next.provider.sent.slice(beforeResult))).toContain("Build and lint");
  expect(JSON.stringify(next.provider.sent.slice(beforeResult))).toContain(link);
  expect(JSON.stringify(next.provider.sent.slice(beforeResult))).not.toContain("run-lint");
  next.provider.receive({
    type: "response.created",
    response: { id: "build-result", metadata: { t3ResultId: completion.resultId } },
  });
  next.provider.receive({
    type: "response.output_audio.delta",
    response_id: "build-result",
    item_id: "result-audio",
    delta: "BQY=",
  });
  next.provider.receive({
    type: "response.output_audio_transcript.done",
    item_id: "result-audio",
    transcript: "The build check in Build and lint passed.",
  });
  next.provider.receive({
    type: "response.done",
    response: { id: "build-result", status: "completed" },
  });
  expect(next.playback.enqueue).toHaveBeenCalledWith(1, new Uint8Array([5, 6]));
  expect(next.record.pending()).toEqual(expect.arrayContaining(["work-1", "work-2"]));
  next.playback.isDrained.mockReturnValue(true);
  next.conversation.feed(new Float32Array());
  expect(next.record.pending()).not.toContain("work-1");
  expect(next.record.pending()).toContain("work-2");
  expect(next.record.context()).toContainEqual({
    speaker: "assistant",
    text: "The build check in Build and lint passed.",
  });
});

it("frees an unsubmitted operation only after T3 confirms it is missing", () => {
  const first = setup();
  first.provider.receive({ type: "input_audio_buffer.committed", item_id: "spoken" });
  first.provider.receive({
    type: "response.function_call_arguments.done",
    name: "queue_work",
    call_id: "lost-send",
    arguments: '{"text":"Check the build"}',
  });
  first.conversation.stop();

  const next = setup(first.storage);
  expect(next.control.sent).toContainEqual({ type: "recover", operationId: "work-1" });
  next.control.receive({
    type: "error",
    operationId: "work-1",
    message: "T3 could not read that task.",
  });
  expect(next.record.pending()).toContain("work-1");
  next.control.receive({
    type: "error",
    operationId: "work-1",
    reason: "operation-not-found",
    message: "That task was not queued.",
  });
  expect(next.record.pending()).not.toContain("work-1");
  expect(next.record.pending()).toContain("previous");
});

it("persists a committed utterance once even when transcription arrives before commit", () => {
  const { control, provider, threadId } = setup();
  const transcript = {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "utterance",
    transcript: "Hello from the current chat",
  };
  provider.receive(transcript);
  expect(control.sent).not.toContainEqual(expect.objectContaining({ type: "transcript" }));
  provider.receive({ type: "input_audio_buffer.committed", item_id: "utterance" });
  provider.receive(transcript);
  expect(control.sent.filter((event) => (event as { type: string }).type === "transcript")).toEqual(
    [expect.objectContaining({ threadId, role: "user", text: transcript.transcript })],
  );
});

it("accepts compatible PCM output and ignores chunks from an interrupted response", () => {
  const { provider, playback } = setup();
  provider.receive({ type: "response.created", response: { id: "reply" } });
  provider.receive({ type: "input_audio_buffer.speech_started", item_id: "barge-in" });
  provider.receive({
    type: "response.audio.delta",
    item_id: "old-output",
    response_id: "reply",
    delta: "AQI=",
  });
  expect(playback.enqueue).not.toHaveBeenCalled();
  provider.receive({ type: "response.done", response: { id: "reply", status: "cancelled" } });
  provider.receive({ type: "response.created", response: { id: "new-reply" } });
  provider.receive({
    type: "response.audio.delta",
    item_id: "new-output",
    response_id: "new-reply",
    delta: "AQI=",
  });
  expect(playback.enqueue).toHaveBeenCalledOnce();
});

it("keeps an in-progress utterance in its original chat and records later utterances in the new chat", () => {
  const { control, provider, conversation, threadId } = setup();
  const nextThread = ThreadId.make("thread:next");
  provider.receive({ type: "input_audio_buffer.speech_started", item_id: "first" });
  conversation.selectThread(nextThread);
  expect(control.sent).toContainEqual({ type: "select", threadId: nextThread });
  control.receive({ type: "target", threadId: nextThread, title: "Next chat" });
  for (const item of ["first", "second"]) {
    provider.receive({ type: "input_audio_buffer.committed", item_id: item });
    provider.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: item,
      transcript: item,
    });
  }
  expect(control.sent).toContainEqual({
    type: "transcript",
    operationId: "item-first",
    threadId,
    role: "user",
    text: "first",
  });
  expect(control.sent).toContainEqual({
    type: "transcript",
    operationId: "item-second",
    threadId: nextThread,
    role: "user",
    text: "second",
  });
});

it("retries unacknowledged transcript writes after reconnect with the same IDs", () => {
  const first = setup();
  first.provider.receive({ type: "input_audio_buffer.committed", item_id: "item-1" });
  first.provider.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item-1",
    transcript: "The password is hunter2.",
  });
  first.conversation.stop();
  const next = setup(first.storage);
  expect(next.control.sent).toContainEqual({
    type: "transcript",
    operationId: "item-item-1",
    threadId: first.threadId,
    role: "user",
    text: "The [credential removed].",
  });
  next.control.receive({ type: "transcript-saved", operationId: "item-item-1" });
  next.conversation.stop();
  const last = setup(first.storage);
  expect(last.control.sent).not.toContainEqual(expect.objectContaining({ type: "transcript" }));
});
