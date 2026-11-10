import {
  OrchestratorMcpFailure,
  VoiceSayInput,
  VoiceSayResult,
  VoiceStatusResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as VoiceSessionService from "../../../voice/VoiceSessionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  VoiceSessionService.VoiceSessionService,
];

const VoiceSayTool = Tool.make("voice_say", {
  description:
    "Say something aloud to the user in the live voice conversation. Messages starting `[voice]` were spoken by the user: answer them with this, since text you write is not heard. One short thought per call. It waits until the user has heard it. `interrupted`: they cut in, and `spokenText` is all they heard. `held`: they are talking or asked for quiet, and it plays later.",
  parameters: VoiceSayInput,
  success: VoiceSayResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Speak to the user")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const VoiceStatusTool = Tool.make("voice_status", {
  description:
    "Report the live voice conversation: whether one is running, whether the user is talking or asked for quiet, what is being said, how much is waiting, and what they last said and heard.",
  success: VoiceStatusResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get voice conversation status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const VoiceToolkit = Toolkit.make(VoiceSayTool, VoiceStatusTool);
