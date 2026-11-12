import {
  CommandId,
  MessageId,
  type ProjectId,
  type RunId,
  type ThreadId,
  VOICE_MESSAGE_ID_PREFIX,
  VOICE_UTTERANCE_PREFIX,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

type Threads = Pick<
  ThreadManagementService["Service"],
  "dispatch" | "sendToThread" | "getProjectThreadRecords"
>;

/** Bind only after the T3 caller has been authorized for this local target. */
export function bindVoiceThreadWork(
  threads: Threads,
  target: { readonly projectId: ProjectId; readonly threadId: ThreadId },
) {
  const { projectId, threadId } = target;
  const operationKey = (operationId: string) =>
    `voice-work:${encodeURIComponent(threadId)}:${encodeURIComponent(operationId)}`;
  const operationMessageId = (operationId: string) =>
    MessageId.make(`message:${operationKey(operationId)}`);
  return {
    dispatchUtterance: Effect.fn("VoiceThreadWork.dispatchUtterance")(function* (
      operationId: string,
      text: string,
    ) {
      return yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`voice:${operationId}`),
        threadId,
        messageId: MessageId.make(`${VOICE_MESSAGE_ID_PREFIX}${operationId}`),
        text: `${VOICE_UTTERANCE_PREFIX}${text}`,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        deliveryIntent: "auto",
        dispatchMode: { type: "start_immediately" },
      });
    }),
    submit: Effect.fn("VoiceThreadWork.submit")(function* (operationId: string, text: string) {
      const receipt = yield* threads.sendToThread({
        projectId,
        threadId,
        commandId: CommandId.make(operationKey(operationId)),
        messageId: operationMessageId(operationId),
        text,
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        mode: "queue",
      });
      return {
        threadId,
        messageId: receipt.message.id,
        runId: receipt.run.id,
        status: receipt.run.status,
        delivery: receipt.delivery,
        taskText: receipt.message.text,
      };
    }),
    recover: Effect.fn("VoiceThreadWork.recover")(function* (operationId: string) {
      const { messages } = yield* threads.getProjectThreadRecords(
        { projectId, threadId },
        ["messages"],
        { messageIds: [operationMessageId(operationId)] },
      );
      const message = messages[0];
      return message === undefined ? null : { runId: message.runId, taskText: message.text };
    }),
    status: Effect.fn("VoiceThreadWork.status")(function* (runId: RunId) {
      const { runs } = yield* threads.getProjectThreadRecords({ projectId, threadId }, ["runs"], {
        runIds: [runId],
      });
      const run = runs.find((candidate) => candidate.id === runId);
      return run === undefined ? null : { threadId, runId, status: run.status };
    }),
  };
}
