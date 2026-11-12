import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  VOICE_WATCH_LIMIT,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VoiceWatch from "./VoiceWatch.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const router = ThreadId.make("thread:voice-router");
const watched = ThreadId.make("thread:watched");
const other = ThreadId.make("thread:other");
const watchdog = ThreadId.make("thread:watchdog");
const environmentId = EnvironmentId.make("environment-voice");

// The real orchestrator, so these prove it accepts the notification the reactor sends.
const layerTest = VoiceWatch.layer.pipe(
  Layer.provideMerge(
    ServerSettings.ServerSettingsService.layerTest({
      voiceRouterThreadId: router,
      voiceWatchdogThreadId: watchdog,
      voiceWatchedThreadIds: [watched],
    }),
  ),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase)),
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "voice-watch" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

const createThread = Effect.fn("test.voiceWatch.createThread")(function* (
  threadId: ThreadId,
  title: string,
  lineage?: OrchestrationV2AppThreadLineage,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:voice"),
    title,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  if (lineage !== undefined) {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventSink.EventSinkV2;
    const thread = yield* projections.getThread(threadId);
    yield* events.write({
      events: [
        {
          id: EventId.make(`event:lineage:${threadId}`),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: { ...thread, lineage },
        },
      ],
    });
  }
});

/** Starts a run in `threadId` and returns the event for it ending with `status`. */
const finishedRun = Effect.fn("test.voiceWatch.finishedRun")(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`start:${threadId}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}`),
    text: "Fix the login bug",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const run = (yield* projections.getThreadProjection(threadId)).runs[0]!;
  return {
    id: EventId.make(`event:${threadId}:${status}`),
    type: "run.updated",
    threadId,
    runId: run.id,
    occurredAt: yield* DateTime.now,
    payload: { ...run, status },
  } satisfies OrchestrationV2DomainEvent;
});

const routerNotices = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projection = yield* projections.getThreadProjection(router);
  return projection.messages.filter((message) => message.notification !== undefined);
});

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2RuntimeRequest));

/**
 * `threadId` stops to ask the user something, or the request is settled. `recorded` is what the
 * projection holds by the time the event is read, which can already be newer than the event.
 */
const request = Effect.fn("test.voiceWatch.request")(function* (
  threadId: ThreadId,
  status: "pending" | "resolved",
  kind: "command" | "user_input" | "dynamic_tool_call" = "command",
  recorded: "pending" | "resolved" = status,
) {
  const sql = yield* SqlClient.SqlClient;
  const occurredAt = yield* DateTime.now;
  const payload = {
    id: RuntimeRequestId.make(`request:${threadId}:${kind}`),
    nodeId: NodeId.make(`node:${threadId}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind,
    status,
    responseCapability:
      kind === "user_input"
        ? { type: "message" as const }
        : {
            type: "live" as const,
            providerSessionId: ProviderSessionId.make("session:voice-watch"),
          },
    createdAt: occurredAt,
    resolvedAt: null,
  };
  const json = encodeRequest({ ...payload, status: recorded });
  yield* sql`
    INSERT INTO orchestration_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
    VALUES (${payload.id}, ${threadId}, ${payload.nodeId}, ${kind}, ${recorded},
      ${DateTime.formatIso(occurredAt)}, ${json})
    ON CONFLICT (runtime_request_id)
    DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json
  `;
  return {
    id: EventId.make(`event:${threadId}:request:${kind}:${status}`),
    type: "runtime-request.updated",
    threadId,
    occurredAt,
    payload,
  } satisfies OrchestrationV2DomainEvent;
});

it.effect("tells the voice thread once when any thread's run ends, with a link to it", () =>
  Effect.gen(function* () {
    const watch = yield* VoiceWatch.VoiceWatch;
    yield* createThread(router, "Voice");
    yield* createThread(other, "Auth fix");
    yield* createThread(watchdog, "Watchdog");

    // Its own run, the watchdog's routine checks and a run still going are not news.
    yield* watch.handle(yield* finishedRun(router, "completed"));
    yield* watch.handle(yield* finishedRun(watchdog, "completed"));
    const running = yield* finishedRun(other, "running");
    yield* watch.handle(running);
    assert.deepEqual(yield* routerNotices, []);

    const done = { ...running, payload: { ...running.payload, status: "failed" as const } };
    yield* watch.handle(done);
    // The same run can report its end more than once; the voice thread hears it once.
    yield* watch.handle(done);
    const notices = yield* routerNotices;
    assert.lengthOf(notices, 1);
    const [notice] = notices;
    assert.include(
      notice!.text,
      `Thread ${other} (Auth fix) [failed]: [Auth fix](t3-thread://v2/${environmentId}/`,
    );
    assert.include(notice!.text, "not a request to you");
    assert.deepEqual(notice!.notification, {
      source: { kind: "system" },
      outcome: "failed",
      summary: 'Thread "Auth fix" failed',
    });
    assert.equal(notice!.createdBy, "agent");
    assert.equal(notice!.creationSource, "server");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reports side chats, nested blockers and settled remote tasks with source links", () =>
  Effect.gen(function* () {
    const watch = yield* VoiceWatch.VoiceWatch;
    const side = ThreadId.make("thread:side");
    const nested = ThreadId.make("thread:nested");
    const remote = ThreadId.make("thread:remote");
    const remoteEnvironment = EnvironmentId.make("environment-remote");
    yield* createThread(router, "Voice");
    yield* createThread(other, "Parent");
    yield* createThread(side, "Side chat", {
      parentThreadId: other,
      rootThreadId: other,
      relationshipToParent: "fork",
      sideChat: true,
    });
    yield* createThread(nested, "Nested worker", {
      parentThreadId: side,
      rootThreadId: other,
      relationshipToParent: "subagent",
    });

    yield* watch.handle(yield* finishedRun(side, "completed"));
    yield* watch.handle(yield* request(nested, "pending"));
    const runEnded = yield* finishedRun(nested, "completed");
    yield* watch.handle(runEnded);
    const now = yield* DateTime.now;
    const task: OrchestrationV2Subagent = {
      id: NodeId.make("node:remote"),
      threadId: nested,
      runId: runEnded.runId,
      parentNodeId: NodeId.make("node:nested"),
      origin: "app_owned",
      createdBy: "agent",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      providerThreadId: null,
      childThreadId: null,
      remoteChild: { environmentId: remoteEnvironment, threadId: remote, label: "Remote" },
      nativeTaskRef: null,
      prompt: "Fix the build",
      title: "Remote build",
      model: null,
      status: "completed",
      result: "Fixed the build",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const completed = {
      id: EventId.make("event:remote:completed"),
      type: "subagent.updated",
      threadId: nested,
      occurredAt: now,
      payload: task,
    } satisfies OrchestrationV2DomainEvent;
    yield* watch.handle({ ...completed, payload: { ...task, result: null } });
    yield* watch.handle(completed);
    yield* watch.handle(completed);
    const { remoteChild: _remoteChild, ...localTask } = task;
    yield* watch.handle({
      ...completed,
      threadId: side,
      payload: {
        ...localTask,
        id: NodeId.make("node:local"),
        threadId: side,
        childThreadId: nested,
        result: "Finished the local work",
      },
    });
    yield* watch.handle({
      ...completed,
      threadId: router,
      payload: { ...task, threadId: router },
    });

    const notices = yield* routerNotices;
    assert.lengthOf(notices, 4);
    assert.isTrue(notices.some((notice) => notice.text.includes("Finished the local work")));
    assert.isTrue(
      notices.some((notice) => notice.text.includes(`t3-thread://v2/${environmentId}/${side}`)),
    );
    assert.isTrue(
      notices.some((notice) => notice.text.includes(`t3-thread://v2/${environmentId}/${nested}`)),
    );
    assert.isTrue(
      notices.some(
        (notice) =>
          notice.text.includes(`t3-thread://v2/${remoteEnvironment}/${remote}`) &&
          notice.text.includes("Fixed the build"),
      ),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("with every-thread reports off, only watched threads are reported", () =>
  Effect.gen(function* () {
    const watch = yield* VoiceWatch.VoiceWatch;
    yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
      voiceAnnounceAllThreads: false,
    });
    yield* createThread(router, "Voice");
    yield* createThread(watched, "Auth fix");
    yield* createThread(other, "Unwatched");
    yield* watch.handle(yield* finishedRun(other, "completed"));
    yield* watch.handle(yield* request(other, "pending"));
    assert.deepEqual(yield* routerNotices, []);
    yield* watch.handle(yield* finishedRun(watched, "completed"));
    assert.lengthOf(yield* routerNotices, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a thread waiting on the user is reported as that, apart from a finished one", () =>
  Effect.gen(function* () {
    const watch = yield* VoiceWatch.VoiceWatch;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread(router, "Voice");
    yield* createThread(other, "Deploy");

    // A tool call the app answers itself is not the user's to settle, and a request already
    // settled by the time its event is read is not worth a turn.
    yield* watch.handle(yield* request(other, "pending", "dynamic_tool_call"));
    yield* watch.handle(yield* request(other, "pending", "command", "resolved"));
    assert.deepEqual(yield* routerNotices, []);

    const asked = yield* request(other, "pending");
    yield* watch.handle(asked);
    yield* watch.handle(asked);
    const [notice, ...rest] = yield* routerNotices;
    assert.deepEqual(rest, []);
    assert.include(
      notice!.text,
      `Thread ${other} (Deploy) is waiting for an approval from the user`,
    );
    assert.notInclude(notice!.text, "t3_pending_request");
    assert.include(notice!.text, "open the link and review the request there");
    // Hearing about it is not leave to settle it.
    assert.include(notice!.text, "Do not reply to that thread, approve, deny, answer or act on it");
    assert.deepEqual(notice!.notification, {
      source: { kind: "system" },
      outcome: "updated",
      summary: 'Thread "Deploy" needs an approval',
    });

    // The voice thread is busy with that notice, so a second thread's question waits its turn.
    yield* watch.handle(yield* request(other, "pending", "user_input"));
    const question = (yield* routerNotices).find((message) => message.id.endsWith(":user_input"));
    assert.include(question?.text, "Work can continue while the request is open.");
    assert.include(question?.text, "t3_pending_request action read");
    assert.equal(question?.notification?.summary, 'Thread "Deploy" requested an answer');
    const queued = () =>
      Effect.map(projections.getThreadProjection(router), (projection) =>
        projection.runs.filter((run) => run.status === "queued"),
      );
    assert.lengthOf(yield* queued(), 1);
    const replacement = ThreadId.make("thread:voice-replacement");
    yield* createThread(replacement, "Replacement voice");
    // Withdraw from the original destination even after the setting changed.
    yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
      voiceAnnounceAllThreads: false,
      voiceRouterThreadId: replacement,
    });
    yield* watch.handle(yield* request(other, "resolved", "user_input"));
    assert.deepEqual(yield* queued(), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("replays stored events and withdraws a queued request from the old voice thread", () =>
  Effect.gen(function* () {
    const watch = yield* VoiceWatch.VoiceWatch;
    const events = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const sql = yield* SqlClient.SqlClient;
    const replacement = ThreadId.make("thread:voice-after-restart");
    yield* createThread(router, "Voice");
    yield* createThread(replacement, "New voice");
    yield* createThread(other, "Deploy");
    yield* createThread(watched, "Other work");

    yield* finishedRun(router, "running");
    const pending = yield* request(other, "pending");
    const [stored] = yield* events.write({ events: [pending] });
    yield* watch.handle(pending);
    const queued = (yield* projections.getThreadProjection(router)).runs.find(
      (run) => run.status === "queued",
    );
    assert.isDefined(queued);

    // Leave the cursor before a notice whose dispatch committed, as a crash can.
    yield* sql`
      INSERT INTO orchestration_v2_projection_metadata
        (projection_name, schema_version, last_sequence, updated_at)
      VALUES ('voice-watch', 1, ${stored!.sequence - 1}, ${DateTime.formatIso(pending.occurredAt)})
    `;
    yield* settings.updateSettings({ voiceRouterThreadId: replacement });
    yield* events.write({ events: [yield* request(other, "resolved")] });
    const completed = yield* finishedRun(other, "completed");
    const ignored = yield* finishedRun(watched, "running");
    yield* events.write({
      events: [completed, ignored],
    });

    const highWater = yield* events.latestSequence();
    yield* watch.start();
    yield* events.stream({ afterSequence: highWater, threadId: replacement }).pipe(
      Stream.filter(({ event }) => event.type === "message.updated"),
      Stream.runHead,
    );
    const old = yield* projections.getThreadProjection(router);
    const next = yield* projections.getThreadProjection(replacement);
    assert.equal(old.runs.find((run) => run.id === queued?.id)?.status, "cancelled");
    assert.lengthOf(
      old.messages.filter((message) => message.notification !== undefined),
      1,
    );
    const [notice, ...extra] = next.messages.filter(
      (message) => message.notification !== undefined,
    );
    assert.deepEqual(extra, []);
    assert.equal(notice?.notification?.outcome, "completed");

    yield* TestClock.adjust(0);
    const [cursor] = yield* sql<{ readonly last_sequence: number }>`
      SELECT last_sequence FROM orchestration_v2_projection_metadata
      WHERE projection_name = 'voice-watch'
    `;
    assert.isAtLeast(cursor!.last_sequence, highWater);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("the voice thread manages a capped watch list, and nobody else does", () =>
  Effect.gen(function* () {
    const watch = yield* VoiceWatch.VoiceWatch;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* createThread(router, "Voice");
    yield* createThread(other, "Docs build");
    const reason = (effect: ReturnType<typeof watch.change>) =>
      Effect.flip(effect).pipe(Effect.map((error) => error.reason));

    assert.equal(yield* reason(watch.change(other, "list", undefined)), "not-voice-thread");
    assert.equal(yield* reason(watch.change(router, "watch", undefined)), "thread-required");
    assert.equal(yield* reason(watch.change(router, "watch", router)), "own-thread");
    assert.equal(
      yield* reason(watch.change(router, "watch", ThreadId.make("thread:missing"))),
      "thread-not-found",
    );
    assert.deepEqual((yield* watch.change(router, "watch", other)).watched, [watched, other]);
    assert.deepEqual((yield* watch.change(router, "watch", other)).watched, [watched, other]);
    assert.deepEqual((yield* watch.change(router, "unwatch", watched)).watched, [other]);
    assert.deepEqual((yield* settings.getSettings).voiceWatchedThreadIds, [other]);

    yield* settings.updateSettings({
      voiceWatchedThreadIds: Array.from({ length: VOICE_WATCH_LIMIT }, (_, index) =>
        ThreadId.make(`thread:full-${index}`),
      ),
    });
    assert.equal(yield* reason(watch.change(router, "watch", other)), "full");
    // Unwatching still works when the list is full.
    assert.lengthOf(
      (yield* watch.change(router, "unwatch", ThreadId.make("thread:full-0"))).watched,
      VOICE_WATCH_LIMIT - 1,
    );
  }).pipe(Effect.provide(layerTest)),
);
