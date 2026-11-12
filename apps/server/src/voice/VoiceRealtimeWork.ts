import {
  CommandId,
  isProviderNativeSubagentThread,
  MessageId,
  VOICE_MESSAGE_ID_PREFIX,
  type ThreadId,
  type VoiceRealtimeCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { looksLikeSecret } from "../memory/secretFilter.ts";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { spokenForm } from "./spokenForm.ts";

type Threads = Pick<
  ThreadManagementService["Service"],
  "dispatch" | "listProjectThreads" | "getThreadShell" | "getThreadSnapshotWindow"
>;

export function realtimeVoiceText(text: string, limit: number) {
  return looksLikeSecret(text) ? "[credential removed]" : text.trim().slice(0, limit);
}

export function bindRealtimeVoiceWork(threads: Threads) {
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
    record: Effect.fn("VoiceRealtimeWork.record")(function* (
      threadId: ThreadId,
      id: string,
      role: Extract<VoiceRealtimeCommand, { type: "transcript" }>["role"],
      raw: string,
    ) {
      const text = realtimeVoiceText(raw, 4000);
      if (!text) return;
      const key = `realtime:${encodeURIComponent(threadId)}:${role}:${id}`;
      yield* threads.dispatch({
        type: "voice.transcript.record",
        commandId: CommandId.make(key),
        messageId: MessageId.make(role === "user" ? `${VOICE_MESSAGE_ID_PREFIX}${key}` : key),
        threadId,
        role,
        text,
      });
    }),
  };
}
