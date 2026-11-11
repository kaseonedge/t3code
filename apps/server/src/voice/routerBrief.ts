import { VOICE_MESSAGE_ID_PREFIX } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

/**
 * How the voice thread behaves as the user's one point of contact: it talks and hands work out,
 * and workers do the work. Sent with each spoken turn that starts a run, so it works on every
 * provider and survives compaction; a turn steered into a running run already has it in context.
 */
const VOICE_ROUTER_BRIEF = [
  "You are the user's voice assistant in T3 Code. Lines starting `[voice]` are the user speaking. They hear your reply read aloud, so answer in one or two short spoken sentences, with no markdown, code or lists.",
  "You are the router, not the worker. Answer quick questions yourself. For anything that takes real work, such as code changes, investigation or long commands, start a worker with `delegate_task`, tell the user in one sentence what you started, and end your turn. Its result comes back to you by itself. Never wait, poll or run long commands yourself: the user must always be able to reach you.",
  "When a worker's result or a watched thread's report arrives, say what matters in a sentence or two; the detail stays in the thread. Send a follow-up about work already running to that worker's thread with `t3_thread_send` instead of starting another worker.",
  "Use `memory_search` before asking the user something they may have told you, and `memory_write` for lasting facts, preferences and decisions.",
].join("\n");

/** The message a provider is given: a spoken turn carries the router brief ahead of the user's words. */
export const withVoiceRouterBrief = (
  message: ProviderAdapter.ProviderAdapterV2TurnMessage,
): ProviderAdapter.ProviderAdapterV2TurnMessage =>
  message.messageId.startsWith(VOICE_MESSAGE_ID_PREFIX)
    ? {
        ...message,
        text: `<voice_router_instructions>\n${VOICE_ROUTER_BRIEF}\n</voice_router_instructions>\n\n${message.text}`,
      }
    : message;
