import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";
import {
  decodeVoiceSessionAudioFrame,
  ElevenLabsSettings,
  encodeVoiceSessionAudioFrame,
  VoiceConversationGrant,
  VoiceSayInput,
  VoiceWatchInput,
  VoiceSessionCommand,
  VoiceSessionEvent,
} from "./voiceSession.ts";
import { secretSettingsFields } from "./settings.ts";

const ok = (schema: Schema.Top, value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema as never)(value));

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

describe("ElevenLabs settings", () => {
  it("defaults to no key, no voice and no voice thread on settings written before voice", () => {
    const settings = decodeSettings({});
    expect(settings.elevenLabs).toEqual({
      apiKey: "",
      voiceId: "",
      speechToTextModel: "scribe_v2_realtime",
      textToSpeechModel: "eleven_flash_v2_5",
      serverLocation: "global",
      zeroRetention: false,
    });
    expect(settings.voiceRouterThreadId).toBeNull();
  });

  it("declares the key, and only the key, as a secret that may name a vault reference", () => {
    expect(secretSettingsFields(ElevenLabsSettings)).toEqual(["apiKey"]);
    const reference = { provider: "work", reference: "op://Work/Voice/key" };
    expect(ok(ServerSettingsPatch, { elevenLabs: { apiKey: reference } })).toBe(true);
  });

  // These values are placed in the URL the key is sent to.
  it.each([
    [{ voiceId: "../v1/voices" }],
    [{ voiceId: "abc?x=1" }],
    [{ textToSpeechModel: "flash&enable_logging=true" }],
    [{ speechToTextModel: "" }],
    [{ serverLocation: "evil.example" }],
  ])("refuses %o", (patch) => {
    expect(ok(ServerSettingsPatch, { elevenLabs: patch })).toBe(false);
    expect(ok(ElevenLabsSettings, patch)).toBe(false);
  });
});

describe("voice session frames", () => {
  it.each([
    [VoiceSessionCommand, { type: "start" }, true],
    [VoiceSessionCommand, { type: "cleared", speechId: 1, playedMs: 420.5 }, true],
    [VoiceSessionCommand, { type: "cleared", speechId: 0, playedMs: 1 }, false],
    [VoiceSessionCommand, { type: "cleared", speechId: 1, playedMs: -1 }, false],
    [VoiceSessionCommand, { type: "say", text: "hi" }, false],
    [
      VoiceSessionEvent,
      { type: "speech_end", speechId: 1, outcome: "interrupted", spokenText: "" },
      true,
    ],
    // `held` is an answer to the agent; a client is only ever told a speech ended.
    [
      VoiceSessionEvent,
      { type: "speech_end", speechId: 1, outcome: "held", spokenText: "" },
      false,
    ],
    [
      VoiceSessionEvent,
      { type: "error", reason: "zero-retention-unavailable", message: "x" },
      true,
    ],
    [VoiceSayInput, { text: "Done." }, true],
    [VoiceSayInput, { text: "" }, false],
    [VoiceSayInput, { text: "Done.", priority: "urgent" }, false],
    [
      VoiceConversationGrant,
      { id: "g1", destination: { kind: "elevenlabs", environmentId: "env-1" } },
      true,
    ],
    [
      VoiceConversationGrant,
      { id: "g1", destination: { kind: "environment", environmentId: "env-1" } },
      false,
    ],
    [ExecutionEnvironmentCapabilities, { voiceConversation: true }, true],
    [VoiceWatchInput, { action: "list" }, true],
    [VoiceWatchInput, { action: "follow", threadId: "t1" }, false],
    [
      ServerSettingsPatch,
      { voiceWatchedThreadIds: Array.from({ length: 20 }, (_, i) => `t${i}`) },
      true,
    ],
    [
      ServerSettingsPatch,
      { voiceWatchedThreadIds: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      false,
    ],
  ] as const)("%# decodes as expected", (schema, value, accepted) => {
    expect(ok(schema, value)).toBe(accepted);
  });

  it("tags speech audio with the speech it belongs to", () => {
    const frame = encodeVoiceSessionAudioFrame(300, new Uint8Array([9, 8]));
    expect(decodeVoiceSessionAudioFrame(frame)).toEqual({
      speechId: 300,
      pcm: new Uint8Array([9, 8]),
    });
    expect(decodeVoiceSessionAudioFrame(new Uint8Array(3))).toBeUndefined();
  });
});
