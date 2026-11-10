import {
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type VoiceHealthFinding,
  type VoiceHealthReport,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VoiceSessionService from "./VoiceSessionService.ts";

/** The voice thread should answer in seconds; this long with nothing new means it is stuck. */
const VOICE_THREAD_STALL = Duration.minutes(10);
/** Workers think and run tools for longer, so they get more room before they count as stuck. */
const WORKER_STALL = Duration.minutes(20);

export class VoiceWatchdogRefusedError extends Schema.TaggedError<VoiceWatchdogRefusedError>()(
  "VoiceWatchdogRefusedError",
  { reason: Schema.Literals(["not-watchdog-thread", "unavailable"]) },
) {
  override get message(): string {
    return this.reason === "not-watchdog-thread"
      ? "Only the watchdog thread and the voice thread can read voice health."
      : "Voice health could not be read.";
  }
}

export class VoiceWatchdog extends Context.Service<
  VoiceWatchdog,
  {
    /**
     * What is wrong now that was not reported before. Computed from recorded state with no
     * model, so asking costs nothing; each problem is returned once, and again only if it
     * clears and comes back.
     */
    readonly report: (
      caller: ThreadId,
    ) => Effect.Effect<VoiceHealthReport, VoiceWatchdogRefusedError>;
  }
>()("t3/voice/VoiceWatchdog") {}

const ACTIVE: ReadonlySet<OrchestrationV2Run["status"]> = new Set(["starting", "running"]);

/** The active run of a thread, and when anything last happened in it. */
function stalledRun(
  records: {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  },
  now: number,
  limit: Duration.Duration,
) {
  const run = records.runs
    .filter((candidate) => ACTIVE.has(candidate.status))
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  if (run === undefined) return undefined;
  const lastActivity = Math.max(
    DateTime.toEpochMillis(run.startedAt ?? run.requestedAt),
    ...records.turnItems
      .filter((item) => item.runId === run.id)
      .map((item) => DateTime.toEpochMillis(item.updatedAt)),
  );
  return now - lastActivity > Duration.toMillis(limit) ? { run, lastActivity } : undefined;
}

const make = Effect.gen(function* () {
  const voice = yield* VoiceSessionService.VoiceSessionService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  // Lost on restart, so a problem that outlives one is reported once more.
  const reported = new Set<string>();

  const inspect = Effect.fn("VoiceWatchdog.inspect")(function* (
    threadId: ThreadId,
    kind: "voice-thread-stalled" | "worker-stalled",
    now: number,
  ) {
    const records = yield* projections.getThreadRecords(threadId, ["runs", "turnItems"]);
    if (records.thread.deletedAt !== null || records.thread.archivedAt !== null) return [];
    const stalled = stalledRun(
      records,
      now,
      kind === "voice-thread-stalled" ? VOICE_THREAD_STALL : WORKER_STALL,
    );
    if (stalled === undefined) return [];
    const minutes = Math.floor((now - stalled.lastActivity) / 60_000);
    const title = records.thread.title.trim() || "Untitled thread";
    return [
      {
        key: `${kind}:${stalled.run.id}`,
        kind,
        threadId,
        summary:
          kind === "voice-thread-stalled"
            ? `The voice thread has been working for ${minutes} minutes with nothing new.`
            : `"${title}" has been running for ${minutes} minutes with nothing new.`,
        since: DateTime.formatIso(DateTime.makeUnsafe(stalled.lastActivity)),
      } satisfies VoiceHealthFinding,
    ];
  });

  const report: VoiceWatchdog["Service"]["report"] = Effect.fn("VoiceWatchdog.report")(
    function* (caller) {
      const unavailable = () => new VoiceWatchdogRefusedError({ reason: "unavailable" });
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      const router = current.voiceRouterThreadId;
      if (caller !== current.voiceWatchdogThreadId && caller !== router)
        return yield* new VoiceWatchdogRefusedError({ reason: "not-watchdog-thread" });
      const checkedAt = yield* DateTime.now;
      const now = DateTime.toEpochMillis(checkedAt);
      const found: Array<VoiceHealthFinding> = (yield* voice.health).map((entry) => ({
        key: `conversation:${entry.seq}`,
        kind: "conversation",
        threadId: null,
        summary: `A voice conversation hit a problem: ${entry.kind}.`,
        since: entry.at,
      }));
      const workers = new Set<ThreadId>(current.voiceWatchedThreadIds);
      if (router !== null) {
        const delegated = yield* projections
          .getThreadRecords(router, ["subagents"])
          .pipe(Effect.mapError(unavailable));
        for (const task of delegated.subagents) {
          if (task.origin === "app_owned" && task.childThreadId !== null)
            workers.add(task.childThreadId);
        }
        workers.delete(router);
        found.push(
          ...(yield* inspect(router, "voice-thread-stalled", now).pipe(
            Effect.mapError(unavailable),
          )),
        );
      }
      for (const worker of workers) {
        // One unreadable thread, such as a deleted one still on the watch list, hides nothing else.
        found.push(
          ...(yield* inspect(worker, "worker-stalled", now).pipe(Effect.orElseSucceed(() => []))),
        );
      }
      const keys = new Set(found.map((finding) => finding.key));
      for (const key of reported) if (!keys.has(key)) reported.delete(key);
      const findings = found.filter((finding) => !reported.has(finding.key));
      for (const finding of findings) reported.add(finding.key);
      return {
        checkedAt: DateTime.formatIso(checkedAt),
        findings,
        ongoing: found.length - findings.length,
      };
    },
  );

  return VoiceWatchdog.of({ report });
});

export const layer = Layer.effect(VoiceWatchdog, make);
