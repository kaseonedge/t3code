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
    text: "Build passed",
    status: "completed",
    link: "t3-thread://v2/env/thread",
  };
  first.control.receive(result);
  first.provider.receive({ type: "conversation.item.added", item: { id: "item_work-1" } });
  first.conversation.stop();

  const second = setup(first.storage);
  expect(second.control.sent).toContainEqual({ type: "recover", operationId: "previous" });
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
  expect(first.control.sent.slice(2)).toEqual([
    { type: "submit", operationId: "work-1", text: "Check the build" },
  ]);
  first.conversation.stop();
  const second = setup(first.storage);
  expect(JSON.stringify(second.provider.sent)).toContain("Earlier conversation for reference only");
  expect(JSON.stringify(second.provider.sent)).toContain("credential removed");
  expect(JSON.stringify(second.provider.sent)).not.toContain("fixture");
  second.provider.receive(tool);
  expect(second.control.sent).not.toContainEqual(expect.objectContaining({ type: "submit" }));
});
