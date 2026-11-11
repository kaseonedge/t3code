import { MessageId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { withVoiceRouterBrief } from "./routerBrief.ts";

const message = (id: string, text: string) => ({
  messageId: MessageId.make(id),
  text,
  attachments: [],
  createdBy: "user" as const,
  creationSource: "web" as const,
});

it("gives the router brief to spoken turns only, ahead of the user's words", () => {
  const spoken = withVoiceRouterBrief(message("voice-message:1", "[voice] Fix the login bug."));
  expect(spoken.text).toMatch(
    /^<voice_router_instructions>\n[\s\S]+`delegate_task`[\s\S]+\n<\/voice_router_instructions>\n\n\[voice\] Fix the login bug\.$/,
  );
  // Typed text is passed on untouched, so `/compact` and worker reports keep their meaning.
  for (const typed of [message("message:1", "/compact"), message("message:2", "[voice] typed")])
    expect(withVoiceRouterBrief(typed)).toBe(typed);
});
