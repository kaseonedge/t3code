import { INITIAL_VOICE_CONVERSATION_STATE } from "@t3tools/client-runtime/voice-conversation";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  useVoiceConversation,
  type VoiceConversationSnapshot,
} from "../../speech/voiceConversation";
import { VoiceLiveTranscript } from "./VoiceLiveTranscript";

vi.mock(import("../../hooks/useSettings"), { spy: true });
vi.mock(import("../../speech/voiceConversation"), { spy: true });

const environmentId = EnvironmentId.make("voice-env");
const voiceThread = ThreadId.make("voice-router");
const otherThread = ThreadId.make("worker");
const live: VoiceConversationSnapshot = {
  ...INITIAL_VOICE_CONVERSATION_STATE,
  phase: "live",
  environmentId,
  acknowledged: false,
};
const speaking = { text: "The build passed.", priority: "reply" } as const;

function show(snapshot: VoiceConversationSnapshot | null) {
  vi.mocked(useEnvironmentSettings).mockImplementation(((
    _id: unknown,
    select: (value: unknown) => unknown,
  ) => select({ ...DEFAULT_SERVER_SETTINGS, voiceRouterThreadId: voiceThread })) as never);
  vi.mocked(useVoiceConversation).mockReturnValue(snapshot);
}

it("shows the user's words only while they are still provisional", async () => {
  show({ ...live, heard: "check one", heardFinal: false });
  await using screen = await render(
    <VoiceLiveTranscript environmentId={environmentId} threadId={voiceThread} />,
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("You check one…");

  // The finished turn is a saved message in the thread now, so the provisional line goes.
  show({ ...live, heard: "Check one, two.", heardFinal: true });
  await screen.rerender(
    <VoiceLiveTranscript environmentId={environmentId} threadId={voiceThread} />,
  );
  expect(screen.getByRole("status").query()).toBeNull();
});

it("shows what the bot is saying, except where its reply is already on screen", async () => {
  show({ ...live, speaking });
  await using screen = await render(
    <VoiceLiveTranscript environmentId={environmentId} threadId={otherThread} />,
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("Speaking The build passed.");

  await screen.rerender(
    <VoiceLiveTranscript environmentId={environmentId} threadId={voiceThread} />,
  );
  expect(screen.getByRole("status").query()).toBeNull();

  // Interrupted or finished: the line goes with the speech.
  show({ ...live, speaking: null });
  await screen.rerender(
    <VoiceLiveTranscript environmentId={environmentId} threadId={otherThread} />,
  );
  expect(screen.getByRole("status").query()).toBeNull();
});

it.each([
  ["no conversation", null],
  ["a conversation that ended", { ...live, phase: "ended", heard: "left over", heardFinal: false }],
  [
    "a conversation on another environment",
    { ...live, environmentId: EnvironmentId.make("other"), speaking },
  ],
] as const)("shows nothing for %s", async (_name, snapshot) => {
  show(snapshot as VoiceConversationSnapshot | null);
  await using screen = await render(
    <VoiceLiveTranscript environmentId={environmentId} threadId={otherThread} />,
  );
  expect(screen.getByRole("status").query()).toBeNull();
});
