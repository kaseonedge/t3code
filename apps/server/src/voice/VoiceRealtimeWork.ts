import {
  CommandId,
  isProviderNativeSubagentThread,
  MessageId,
  VOICE_MESSAGE_ID_PREFIX,
  type ThreadId,
  type ProjectId,
  type RunId,
  type VoiceRealtimeEvent,
  type VoiceRealtimeCommand,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import type * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import { looksLikeSecret } from "../memory/secretFilter.ts";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { spokenForm } from "./spokenForm.ts";

type Threads = Pick<
  ThreadManagementService["Service"],
  | "dispatch"
  | "listProjectThreads"
  | "getThreadShell"
  | "getThreadSnapshotWindow"
  | "getThreadRecords"
  | "waitForThread"
  | "getProjectThreadRecords"
>;

export function realtimeVoiceText(text: string, limit: number) {
  return looksLikeSecret(text) ? "[credential removed]" : text.trim().slice(0, limit);
}

type Result = Omit<Extract<VoiceRealtimeEvent, { type: "result" }>, "operationId">;
const MAX_RESULT_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

export function bindRealtimeVoiceWork(threads: Threads, scope: Scope.Scope) {
  const watching = new Map<RunId, Deferred.Deferred<Result | null>>();
  const record = Effect.fn("VoiceRealtimeWork.record")(function* (
    threadId: ThreadId,
    id: string,
    role: Extract<VoiceRealtimeCommand, { type: "transcript" }>["role"],
    raw: string,
  ) {
    const text = realtimeVoiceText(raw, 4000);
    if (!text) return;
    const key = `realtime:${encodeURIComponent(threadId)}:${role}:${id}`;
    const messageId = MessageId.make(role === "user" ? `${VOICE_MESSAGE_ID_PREFIX}${key}` : key);
    if (id.startsWith("voice-result:")) {
      const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
        messageIds: [messageId],
      });
      if (messages.some((message) => message.id === messageId)) return;
    }
    yield* threads.dispatch({
      type: "voice.transcript.record",
      commandId: CommandId.make(key),
      messageId,
      threadId,
      role,
      text,
    });
  });
  const complete = Effect.fn("VoiceRealtimeWork.complete")(function* (input: {
    target: { projectId: ProjectId; threadId: ThreadId };
    runId: RunId;
    origin: ThreadId;
    title: string;
    link: string;
    taskText: string;
  }) {
    const { target, runId, origin, title, link } = input;
    // The thread-wide delegated-work wait can return a different task's latest run.
    const { run, timedOut } = yield* threads.waitForThread({
      ...target,
      runId,
      timeoutMs: MAX_RESULT_WAIT_MS,
    });
    if (!run || timedOut) return null;
    const { messages } = yield* threads.getProjectThreadRecords(target, ["messages"], {
      messageRunIds: [run.id],
      messageRoles: ["assistant"],
    });
    const text = spokenForm(
      realtimeVoiceText(messages.filter((message) => !message.streaming).at(-1)?.text ?? "", 4000),
    )
      .join(" ")
      .slice(0, 1200);
    const taskLabel = spokenForm(realtimeVoiceText(input.taskText, 4000)).join(" ").slice(0, 160);
    const resultId = `voice-result:${runId}`;
    yield* record(
      origin,
      resultId,
      "assistant",
      `T3 task “${taskLabel}” in ${link} ${run.status}. ${text}`,
    );
    return {
      type: "result" as const,
      resultId,
      sourceRunId: runId,
      conversationThreadId: origin,
      threadId: target.threadId,
      threadTitle: title,
      taskLabel,
      status: run.status,
      text,
      link,
    };
  });
  const find = Effect.fn("VoiceRealtimeWork.find")(function* (threadId: ThreadId) {
    const thread = yield* threads.getThreadShell(threadId);
    return thread &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.lineage.sideChat !== true &&
      !isProviderNativeSubagentThread(thread)
      ? thread
      : null;
  });
  return {
    find,
    discover: Effect.fn("VoiceRealtimeWork.discover")(function* (query: string) {
      const matches = yield* threads.listProjectThreads({ includeSubagents: true });
      const needle = query.trim().toLowerCase();
      return matches
        .filter(
          (thread) =>
            !isProviderNativeSubagentThread(thread) && thread.title.toLowerCase().includes(needle),
        )
        .slice(0, 12)
        .map((thread) => ({
          threadId: thread.id,
          title: realtimeVoiceText(thread.title, 120),
          status: thread.activityRunStatus ?? "idle",
        }));
    }),
    read: Effect.fn("VoiceRealtimeWork.read")(function* (threadId: ThreadId) {
      const thread = yield* find(threadId);
      if (!thread) return null;
      const { projection } = yield* threads.getThreadSnapshotWindow(threadId, { rowLimit: 20 });
      return {
        title: realtimeVoiceText(thread.title, 120),
        messages: projection.messages
          .filter(({ role, streaming }) => role !== "system" && !streaming)
          .slice(-6)
          .map(({ role, text }) => ({
            role,
            text: spokenForm(realtimeVoiceText(text, 1200)).join(" ").slice(0, 500),
          })),
      };
    }),
    record,
    watch: Effect.fn("VoiceRealtimeWork.watch")(function* (input: Parameters<typeof complete>[0]) {
      const pending = yield* Deferred.make<Result | null>();
      const existing = watching.get(input.runId);
      if (existing) return Deferred.await(existing);
      if (watching.size >= 256) return Effect.succeed(null);
      watching.set(input.runId, pending);
      yield* complete(input).pipe(
        Effect.orElseSucceed(() => null),
        Effect.flatMap((result) => Deferred.succeed(pending, result)),
        Effect.ensuring(Effect.sync(() => watching.delete(input.runId))),
        Effect.forkIn(scope),
      );
      return Deferred.await(pending);
    }),
  };
}
