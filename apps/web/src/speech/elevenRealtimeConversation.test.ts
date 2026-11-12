import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { openElevenRealtimeConversation } from "./elevenRealtimeConversation";

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

const setup = () => {
  const control = new FakeSocket();
  const provider = new FakeSocket();
  const threadId = ThreadId.make("thread:voice");
  const playback = {
    enqueue: vi.fn(),
    clear: vi.fn(() => 123),
    reset: vi.fn(),
    adjustVolume: vi.fn(() => 1),
  };
  const pending = new Set(["previous"]);
  let count = 0;
  const conversation = openElevenRealtimeConversation({
    url: "wss://t3.invalid",
    threadId,
    playback,
    canSend: () => true,
    onState: vi.fn(),
    onAcknowledged: vi.fn(),
    newOperationId: () => `work-${++count}`,
    operations: {
      pending: () => [...pending],
      remember: (id) => pending.add(id),
      forget: (id) => pending.delete(id),
    },
    createSocket: (url) =>
      (url.includes("t3.invalid") ? control : provider) as unknown as WebSocket,
  });
  control.onopen?.();
  control.receive({ type: "ready", threadId, value: "fixture" });
  provider.receive({ type: "session.created" });
  return { control, provider, playback, conversation, pending, threadId };
};

it("returns a work receipt before completion and delivers a late result as fresh context", () => {
  const { control, provider, pending, threadId } = setup();
  expect(control.sent).toEqual([
    { type: "start", threadId },
    { type: "recover", operationId: "previous" },
  ]);
  provider.receive({ type: "input_audio_buffer.speech_started" });
  provider.receive({ type: "input_audio_buffer.speech_stopped" });
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
    { type: "response.create" },
  ]);
  expect(pending.has("work-1")).toBe(true);
  provider.receive({ type: "conversation.item.added", item: { id: "item_work-2" } });
  expect(pending.has("work-1")).toBe(false);
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
