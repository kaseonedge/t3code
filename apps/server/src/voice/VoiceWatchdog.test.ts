import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type VoiceHealthEntry,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VoiceSessionService from "./VoiceSessionService.ts";
import * as VoiceWatchdog from "./VoiceWatchdog.ts";

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
const watchdogThread = ThreadId.make("thread:watchdog");
const watched = ThreadId.make("thread:watched");
const health: Array<VoiceHealthEntry> = [];

// The real orchestrator and projections under a test clock; no provider ever answers, so every
// run stays active and only the clock decides what counts as stalled.
const layerTest = VoiceWatchdog.layer.pipe(
  Layer.provide(
    Layer.mock(VoiceSessionService.VoiceSessionService)({
      health: Effect.sync(() => [...health]),
    }),
  ),
  Layer.provideMerge(
    ServerSettings.ServerSettingsService.layerTest({
      voiceRouterThreadId: router,
      voiceWatchdogThreadId: watchdogThread,
      voiceWatchedThreadIds: [watched],
    }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "voice-watchdog" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

const startThread = Effect.fn("test.voiceWatchdog.startThread")(function* (
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
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`start:${threadId}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}`),
    text: "Work on it",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
});

it.effect("reports each stall and conversation failure once, and again only if it comes back", () =>
  Effect.gen(function* () {
    const watchdog = yield* VoiceWatchdog.VoiceWatchdog;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* startThread(router, "Voice");
    yield* startThread(watched, "Docs build");
    const routerRun = (yield* projections.getThreadProjection(router)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate:auth-fix"),
      parentThreadId: router,
      parentRunId: routerRun.id,
      parentNodeId: routerRun.rootNodeId!,
      task: "Fix the auth bug",
      completionWake: "settled_only",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const child = (yield* projections.getThreadProjection(router)).subagents[0]!.childThreadId!;
    const kinds = (report: { readonly findings: ReadonlyArray<{ readonly kind: string }> }) =>
      report.findings.map((finding) => finding.kind);

    const refused = yield* Effect.flip(watchdog.report(watched));
    assert.equal(refused.reason, "not-watchdog-thread");
    assert.deepEqual(yield* watchdog.report(watchdogThread), {
      checkedAt: "1970-01-01T00:00:00.000Z",
      findings: [],
      ongoing: 0,
    });

    // The voice thread should answer in seconds; workers get longer.
    yield* TestClock.adjust("11 minutes");
    const first = yield* watchdog.report(watchdogThread);
    assert.deepEqual(kinds(first), ["voice-thread-stalled"]);
    assert.equal(first.findings[0]?.threadId, router);
    assert.include(first.findings[0]?.summary, "11 minutes");
    assert.deepInclude(yield* watchdog.report(watchdogThread), { findings: [], ongoing: 1 });

    yield* TestClock.adjust("10 minutes");
    const workers = yield* watchdog.report(watchdogThread);
    assert.deepEqual(kinds(workers), ["worker-stalled", "worker-stalled"]);
    assert.sameMembers(
      workers.findings.map((finding) => finding.threadId),
      [watched, child],
    );
    assert.equal(workers.ongoing, 1);

    health.push({ seq: 1, at: "1970-01-01T00:20:00.000Z", kind: "rate-limit" });
    const failure = yield* watchdog.report(router);
    assert.deepEqual(kinds(failure), ["conversation"]);
    assert.include(failure.findings[0]?.summary, "rate-limit");
    assert.deepInclude(yield* watchdog.report(watchdogThread), { findings: [], ongoing: 4 });

    // A problem that went away is forgotten, so it is told again if it returns.
    yield* settings.updateSettings({ voiceWatchedThreadIds: [] });
    assert.deepInclude(yield* watchdog.report(watchdogThread), { findings: [], ongoing: 3 });
    yield* settings.updateSettings({ voiceWatchedThreadIds: [watched] });
    const back = yield* watchdog.report(watchdogThread);
    assert.deepEqual(
      back.findings.map((finding) => finding.threadId),
      [watched],
    );
  }).pipe(Effect.provide(layerTest)),
);
