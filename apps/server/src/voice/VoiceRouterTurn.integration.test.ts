import * as NodeURL from "node:url";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId, type VoiceSessionEvent } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "@t3tools/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { provideDeterministicTestRuntime } from "../orchestration-v2/testkit/DeterministicRuntime.ts";
import {
  materializeFixtureInput,
  SIMPLE_PROMPT,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import { findReplayFixture } from "../orchestration-v2/testkit/ProviderReplayFixtures.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { withVoiceRouterBrief } from "./routerBrief.ts";
import * as VoiceSessionService from "./VoiceSessionService.ts";
import { bindVoiceThreadWork } from "./VoiceThreadWork.ts";
import { VoiceSpeechProvider, type VoiceSpeechSinks } from "./VoiceSpeechProvider.ts";

const SPOKEN_TURN = `[voice] ${SIMPLE_PROMPT}`;
/** What the provider is sent for it: the router brief, then the user's words. */
const PROVIDER_TURN = withVoiceRouterBrief({
  messageId: MessageId.make("voice-message:fixture"),
  text: SPOKEN_TURN,
  attachments: [],
  createdBy: "user",
  creationSource: "web",
}).text;

const replayVoiceTask = (mode: "standard" | "realtime") =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = findReplayFixture("simple")!;
      const variant = fixture.providers.find((provider) => provider.driver === "codex")!;
      const cwd = yield* checkpointWorkspace("voice-router-turn");
      const fs = yield* FileSystem.FileSystem;
      const recorded = yield* fs.readFileString(NodeURL.fileURLToPath(variant.transcriptFile));
      // The recording was made with the bare prompt; the voice thread is sent it marked as spoken.
      const rewritten = yield* decodeProviderReplayNdjson(
        mode === "standard"
          ? recorded.replaceAll(SIMPLE_PROMPT, JSON.stringify(PROVIDER_TURN).slice(1, -1))
          : recorded,
      );
      const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(
          materializeReplayTranscriptRuntimeInstructions(rewritten, {
            driver: variant.driver,
            model: variant.modelSelection.model,
          }),
          cwd,
        ),
      );
      const materialized = yield* materializeFixtureInput({
        scenario: "simple",
        fixtureInput: fixture.buildInput(),
        driver: variant.driver,
        modelSelection: variant.modelSelection,
      }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
      const createThread = materialized.commands.find(
        (command) => command.type === "thread.create",
      )!;
      const threadId = materialized.projectionThreadIds[0]!;

      const layerOrchestrator = ProviderReplayHarness.layerProviderReplay(
        {
          name: "voice-router-turn/codex",
          transcript,
          commands: [],
          runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd },
        },
        CodexOrchestratorReplayHarness,
      );
      const layerSettings = ServerSettings.layerTest({
        elevenLabs: { apiKey: "fixture-not-a-key", voiceId: "VoiceFixture01" },
        voiceRouterThreadId: threadId,
      });
      const layerThreads = ThreadManagementService.layer.pipe(
        Layer.provide(layerOrchestrator),
        Layer.provide(layerSettings),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      );
      let sinks: VoiceSpeechSinks | undefined;
      // The only stand-in: speech. Everything after "the user finished speaking" is real.
      const layerSpeech = Layer.mock(VoiceSpeechProvider)({
        connect: (_config, connected) =>
          Effect.sync(() => {
            sinks = connected;
            return {
              transcriber: { send: () => Effect.void },
              synthesizer: {
                speak: (contextId) => connected.onSynthesizer({ type: "done", contextId }),
                cancel: () => Effect.void,
              },
            };
          }),
      });
      const layerTest = VoiceSessionService.layer.pipe(
        Layer.provide(layerSpeech),
        Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        Layer.provideMerge(layerThreads),
        Layer.provideMerge(layerOrchestrator),
        Layer.provide(layerSettings),
        Layer.provide(
          CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript).pipe(
            Layer.provide(McpProviderSessions.layer),
          ),
        ),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const voice = yield* VoiceSessionService.VoiceSessionService;
        const created = yield* orchestrator.dispatch(createThread);
        if (mode === "realtime") {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const origin = ThreadId.make("voice:realtime-origin");
          yield* orchestrator.dispatch({
            ...createThread,
            commandId: CommandId.make("voice:realtime-origin-create"),
            threadId: origin,
            title: "Primary chat",
          });
          const work = bindVoiceThreadWork(threads, {
            projectId: createThread.projectId,
            threadId,
          });
          const receipt = yield* work.submit("test-realtime-task", SIMPLE_PROMPT, origin);
          assert.include(receipt, { threadId, taskText: SIMPLE_PROMPT });
          const result = yield* threads.waitForThread({
            projectId: createThread.projectId,
            threadId,
            runId: receipt.runId,
            timeoutMs: 10_000,
            untilDelegatedWorkSettled: true,
          });
          assert.equal(result.run?.status, "completed");
          const recovered = yield* work.recover("test-realtime-task");
          assert.deepInclude(recovered, { runId: receipt.runId, senderThreadId: origin });
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.include(
            projection.messages.find((message) => message.role === "assistant")?.text,
            "fixture simple ok",
          );
          const originProjection = yield* orchestrator.getThreadProjection(origin);
          assert.isEmpty(originProjection.runs);
          return;
        }
        const frames = yield* Queue.unbounded<VoiceSessionEvent>();
        yield* voice.open({
          send: (event) => Queue.offer(frames, event),
          sendAudio: () => Effect.void,
        });

        yield* sinks!.onTranscriber({ type: "committed", text: SIMPLE_PROMPT });
        const finished = yield* orchestrator
          .streamStoredEventsFrom({ threadId, afterSequence: created.sequence })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                ["completed", "failed", "interrupted", "cancelled"].includes(
                  stored.event.payload.status,
                ),
            ),
            Stream.runHead,
          );
        assert.isTrue(Option.isSome(finished), "the voice thread's run never ended");

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["completed"],
        );
        const said = projection.messages.find((message) => message.role === "user");
        assert.deepInclude(said, { text: SPOKEN_TURN, createdBy: "user", creationSource: "web" });
        const answer = projection.messages.find((message) => message.role === "assistant");
        assert.include(answer?.text, "fixture simple ok");
        // The reply the provider wrote is also what the bot says, though it never called a tool.
        const events: Array<VoiceSessionEvent> = [];
        yield* Queue.take(frames).pipe(
          Effect.tap((event) => Effect.sync(() => void events.push(event))),
          Effect.repeat({ until: (event) => event.type === "speech_start" }),
        );
        assert.deepInclude(events.at(-1), { type: "speech_start", priority: "reply" });
        assert.include(JSON.stringify(events.at(-1)), "fixture simple ok");
        // The user was told the turn was heard before the provider had answered.
        assert.deepInclude(events, { type: "acknowledged", text: SIMPLE_PROMPT });
        assert.isFalse(events.some((event) => event.type === "error"));
      }).pipe(Effect.provide(layerTest));
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.live.each(["standard", "realtime"] as const)(
  "a %s voice task runs through real dispatch and Replay",
  replayVoiceTask,
);
