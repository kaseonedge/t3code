import { assert, it } from "@effect/vitest";
import { MessageId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { bindVoiceThreadWork } from "./VoiceThreadWork.ts";

it.effect("binds queued voice work to the authorized thread across reconnects", () =>
  Effect.gen(function* () {
    const target = {
      projectId: ProjectId.make("project:work"),
      threadId: ThreadId.make("thread:work"),
    };
    const runId = RunId.make("run:work");
    const commands: ThreadManagement.ThreadManagementSendInput[] = [];
    const receipts = new Set<string>();
    const threads = yield* ThreadManagement.ThreadManagementService.pipe(
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: (input) =>
            Effect.sync(() => {
              commands.push(input);
              receipts.add(input.commandId);
              return {
                message: { id: MessageId.make(input.messageId) },
                run: { id: runId, status: "queued" },
                delivery: "queued",
              } as never;
            }),
          getProjectThreadRecords: (scope, _fields, filter) =>
            Effect.sync(() => {
              assert.deepEqual(scope, target);
              assert.deepEqual(filter?.runIds, [runId]);
              return { runs: [{ id: runId, status: "running" }] } as never;
            }),
        }),
      ),
    );

    const first = yield* bindVoiceThreadWork(threads, target).submit(
      "operation:1",
      "Check the build",
    );
    const reconnected = bindVoiceThreadWork(threads, target);
    assert.deepEqual(yield* reconnected.submit("operation:1", "Check the build"), first);
    assert.equal(receipts.size, 1);
    assert.equal(first.delivery, "queued");
    assert.isTrue(commands.every((command) => command.threadId === target.threadId));
    assert.isTrue(commands.every((command) => command.mode === "queue"));
    assert.deepEqual(yield* reconnected.status(first.runId), {
      threadId: target.threadId,
      runId,
      status: "running",
    });
  }),
);
