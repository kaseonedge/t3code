import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  VOICE_WATCH_LIMIT,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
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

// The real orchestrator, so these prove it accepts the notification the reactor sends.
const layerTest = VoiceWatch.layer.pipe(
  Layer.provideMerge(
    ServerSettings.ServerSettingsService.layerTest({
      voiceRouterThreadId: router,
      voiceWatchedThreadIds: [watched],
    }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
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

it.effect("tells the voice thread once when a watched thread's run ends, and only then", () =>
  Effect.gen(function* () {
    const watch = yield* VoiceWatch.VoiceWatch;
    yield* createThread(router, "Voice");
    yield* createThread(watched, "Auth fix");
    yield* createThread(other, "Unwatched");

    yield* watch.handle(yield* finishedRun(other, "completed"));
    const running = yield* finishedRun(watched, "running");
    yield* watch.handle(running);
    assert.deepEqual(yield* routerNotices, []);

    const done = { ...running, payload: { ...running.payload, status: "completed" as const } };
    yield* watch.handle(done);
    // The same run can report its end more than once; the voice thread hears it once.
    yield* watch.handle(done);
    const notices = yield* routerNotices;
    assert.lengthOf(notices, 1);
    const [notice] = notices;
    assert.include(notice!.text, `Watched thread ${watched} (Auth fix) [completed]`);
    assert.deepEqual(notice!.notification, {
      source: { kind: "system" },
      outcome: "completed",
      summary: 'Watched thread "Auth fix" completed',
    });
    assert.equal(notice!.createdBy, "agent");
    assert.equal(notice!.creationSource, "server");
  }).pipe(Effect.provide(layerTest)),
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
