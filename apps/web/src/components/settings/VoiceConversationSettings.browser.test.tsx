import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import {
  useClientSettings,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../hooks/useSettings";
import { startVoiceConversation } from "../../speech/voiceConversation";
import { revokeVoiceConversation } from "../../speech/voiceConversationConsent";
import { useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { VoiceConversationSettings } from "./VoiceConversationSettings";

vi.mock(import("../../hooks/useSettings"), { spy: true });
vi.mock(import("../../state/entities"), { spy: true });
vi.mock(import("../../state/environments"), { spy: true });
vi.mock(import("../../state/session"), { spy: true });
vi.mock(import("../../speech/voiceConversation"), { spy: true });
vi.mock("./MemorySettings", () => ({ MemorySettings: () => null }));
vi.mock("./SecretSourceInput", () => ({
  useSecretSources: () => [],
  SecretSourceInput: () => null,
}));

const environmentId = EnvironmentId.make("voice-env");
const router = ThreadId.make("voice-router");
const worker = ThreadId.make("worker");

function setup(settings: Partial<typeof DEFAULT_SERVER_SETTINGS>) {
  revokeVoiceConversation();
  const save = vi.fn();
  const server = { ...DEFAULT_SERVER_SETTINGS, ...settings };
  vi.mocked(useEnvironments).mockReturnValue({
    environments: [
      {
        environmentId,
        label: "Studio Mac",
        serverConfig: { environment: { capabilities: { voiceConversation: true } } },
      },
    ],
  } as never);
  vi.mocked(useEnvironmentSettings).mockImplementation(((
    _id: unknown,
    select: (s: unknown) => unknown,
  ) => select(server)) as never);
  vi.mocked(useUpdateEnvironmentSettings).mockReturnValue(save as never);
  vi.mocked(useClientSettings).mockReturnValue({ voiceMicrophone: "" } as never);
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  vi.mocked(usePreparedConnection).mockReturnValue(Option.some({ environmentId }) as never);
  vi.mocked(useThreadShells).mockReturnValue([
    { environmentId, id: router, title: "Voice" },
    { environmentId, id: worker, title: "Auth fix" },
  ] as never);
  vi.mocked(startVoiceConversation).mockResolvedValue(undefined);
  return { save };
}

// The harness lays the switch out with no size, so it is pressed from the keyboard instead.
const toggleConsent = async (screen: {
  getByRole: Awaited<ReturnType<typeof render>>["getByRole"];
}) => {
  (
    screen
      .getByRole("switch", { name: "Allow voice conversations on this device" })
      .element() as HTMLElement
  ).focus();
  await userEvent.keyboard(" ");
};

it("starts only after this device consents, bound to that act of consent", async () => {
  setup({
    elevenLabs: {
      ...DEFAULT_SERVER_SETTINGS.elevenLabs,
      apiKey: "saved",
      voiceId: "VoiceFixture01",
    },
    voiceRouterThreadId: router,
  });
  await using screen = await render(<VoiceConversationSettings />);
  const start = screen.getByRole("button", { name: "Start" });
  await expect.element(start).toBeDisabled();
  await expect.element(screen.getByText("Allow voice conversations on this device.")).toBeVisible();

  await toggleConsent(screen);
  await expect.element(start).toBeEnabled();
  await userEvent.click(start);
  const grant = JSON.parse(window.localStorage.getItem("t3code:voice-conversation-grant:v1")!);
  expect(grant.destination).toEqual({ kind: "elevenlabs", environmentId });
  expect(startVoiceConversation).toHaveBeenCalledWith(
    expect.objectContaining({ environmentId, grantId: grant.id }),
  );

  // Turning consent off is the way back: the grant is gone and Start is blocked again.
  await toggleConsent(screen);
  expect(window.localStorage.getItem("t3code:voice-conversation-grant:v1")).toBeNull();
  await expect.element(start).toBeDisabled();
});

it("names the first missing piece, and lets a key and a watched thread be removed", async () => {
  const { save } = setup({
    elevenLabs: { ...DEFAULT_SERVER_SETTINGS.elevenLabs, apiKey: "saved" },
    voiceWatchedThreadIds: [worker],
  });
  await using screen = await render(<VoiceConversationSettings />);
  await expect.element(screen.getByText("Enter an ElevenLabs voice.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Stop watching this thread" }));
  expect(save).toHaveBeenLastCalledWith({ voiceWatchedThreadIds: [] });
  await userEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(save).toHaveBeenLastCalledWith({ elevenLabs: { apiKey: "" } });
});
