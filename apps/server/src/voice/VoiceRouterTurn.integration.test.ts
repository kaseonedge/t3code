import * as NodeURL from "node:url";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type VoiceSessionEvent } from "@t3tools/contracts";
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
import * as VoiceSessionService from "./VoiceSessionService.ts";
import { VoiceSpeechProvider, type VoiceSpeechSinks } from "./VoiceSpeechProvider.ts";

const SPOKEN_TURN = `[voice] ${SIMPLE_PROMPT}`;

/**
 * A spoken turn, end to end, with no paid model and no ElevenLabs: the real voice service, the
 * real thread service and orchestrator, the real effect worker and Codex adapter, answered by a
 * recorded Codex session. The recording is strict: it fails unless the prompt the provider is
 * sent is exactly the `[voice]` message.
 */
it.live("a spoken turn runs the voice thread through the real dispatch path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = findReplayFixture("simple")!;
      const variant = fixture.providers.find((provider) => provider.driver === "codex")!;
      const cwd = yield* checkpointWorkspace("voice-router-turn");
      const fs = yield* FileSystem.FileSystem;
      const recorded = yield* fs.readFileString(NodeURL.fileURLToPath(variant.transcriptFile));
      // The recording was made with the bare prompt; the voice thread is sent it marked as spoken.
      const rewritten = yield* decodeProviderReplayNdjson(
        recorded.replaceAll(SIMPLE_PROMPT, SPOKEN_TURN),
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
              synthesizer: { speak: () => Effect.void, cancel: () => Effect.void },
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
        // The user was told the turn was heard before the provider had answered.
        const events = yield* Queue.takeAll(frames);
        assert.deepInclude(events, { type: "acknowledged", text: SIMPLE_PROMPT });
        assert.isFalse(events.some((event) => event.type === "error"));
      }).pipe(Effect.provide(layerTest));
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
