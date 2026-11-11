import { INITIAL_VOICE_CONVERSATION_STATE } from "@t3tools/client-runtime/voice-conversation";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { useClientSettings, useEnvironmentSettings } from "../../hooks/useSettings";
import {
  startVoiceConversation,
  stopVoiceConversation,
  useVoiceConversation,
} from "../../speech/voiceConversation";
import {
  grantVoiceConversation,
  revokeVoiceConversation,
} from "../../speech/voiceConversationConsent";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { ComposerVoiceConversationButton } from "./ComposerVoiceConversationButton";

vi.mock(import("@effect/atom-react"), { spy: true });
vi.mock(import("../../hooks/useSettings"), { spy: true });
vi.mock(import("../../state/session"), { spy: true });
vi.mock(import("../../speech/voiceConversation"), { spy: true });

const environmentId = EnvironmentId.make("voice-env");
const ready = {
  ...DEFAULT_SERVER_SETTINGS,
  elevenLabs: { ...DEFAULT_SERVER_SETTINGS.elevenLabs, apiKey: "saved", voiceId: "VoiceFixture01" },
  voiceRouterThreadId: ThreadId.make("voice-router"),
};

function setup(options: {
  readonly settings?: typeof DEFAULT_SERVER_SETTINGS;
  readonly supported?: boolean;
  readonly consented?: boolean;
  readonly phase?: "connecting" | "live";
}) {
  revokeVoiceConversation();
  if (options.consented ?? true) grantVoiceConversation(environmentId);
  const settings = options.settings ?? ready;
  vi.mocked(useAtomValue).mockReturnValue((options.supported ?? true) as never);
  vi.mocked(useEnvironmentSettings).mockImplementation(((
    _id: unknown,
    select: (value: unknown) => unknown,
  ) => select(settings)) as never);
  vi.mocked(useClientSettings).mockReturnValue({ voiceMicrophone: "" } as never);
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  vi.mocked(usePreparedConnection).mockReturnValue(Option.some({ environmentId }) as never);
  vi.mocked(startVoiceConversation).mockResolvedValue(undefined);
  vi.mocked(stopVoiceConversation).mockReturnValue(undefined);
  vi.mocked(useVoiceConversation).mockReturnValue(
    options.phase
      ? {
          ...INITIAL_VOICE_CONVERSATION_STATE,
          phase: options.phase,
          environmentId,
          acknowledged: false,
        }
      : null,
  );
}

it("starts the conversation under this device's consent, and shows nothing where unsupported", async () => {
  setup({});
  await using screen = await render(
    <ComposerVoiceConversationButton environmentId={environmentId} />,
  );
  const button = screen.getByRole("button", { name: "Start voice conversation" });
  await expect.element(button).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(button);
  const grant = JSON.parse(window.localStorage.getItem("t3code:voice-conversation-grant:v1")!);
  expect(startVoiceConversation).toHaveBeenCalledWith(
    expect.objectContaining({ environmentId, grantId: grant.id }),
  );

  setup({ supported: false });
  await screen.rerender(<ComposerVoiceConversationButton environmentId={environmentId} />);
  expect(screen.getByRole("button").query()).toBeNull();
});

it("is pressed while a conversation is on, and ends it", async () => {
  setup({ phase: "live" });
  await using screen = await render(
    <ComposerVoiceConversationButton environmentId={environmentId} />,
  );
  const button = screen.getByRole("button", { name: "End voice conversation" });
  await expect.element(button).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(button);
  expect(stopVoiceConversation).toHaveBeenCalledTimes(1);
  expect(startVoiceConversation).not.toHaveBeenCalled();
});

it.each([
  ["consent is missing", { consented: false }],
  ["no voice thread is chosen", { settings: { ...ready, voiceRouterThreadId: null } }],
])("opens setup instead of starting when %s", async (_name, options) => {
  setup(options);
  await using screen = await render(
    <ComposerVoiceConversationButton environmentId={environmentId} />,
    { router: "/threads/1" },
  );
  await userEvent.click(screen.getByRole("button", { name: "Set up voice conversation" }));
  expect(startVoiceConversation).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(screen.router?.state.location).toMatchObject({
      pathname: "/settings/voice",
      hash: "voice-conversation-section",
    }),
  );
  // Clicking never grants consent on the user's behalf.
  if ("consented" in options)
    expect(window.localStorage.getItem("t3code:voice-conversation-grant:v1")).toBeNull();
});
