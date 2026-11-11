# Voice conversation

A voice conversation is a live, two-way spoken exchange with one thread, the **voice thread**
(`voiceRouterThreadId` in server settings). It is separate from [voice input](voice-input.md), which
only edits a composer draft. The server side is in [`apps/server/src/voice`](../../apps/server/src/voice),
the shared client logic in [`packages/client-runtime/src/voice-conversation`](../../packages/client-runtime/src/voice-conversation),
and the browser glue in [`apps/web/src/speech/voiceConversation.ts`](../../apps/web/src/speech/voiceConversation.ts).
Mobile has no client yet.

## Why the server holds both speech connections

The server opens two outbound sockets to ElevenLabs, one for speech to text and one for text to
speech, and the client only talks to `/ws/voice-session`. The alternatives were rejected:

- A hosted voice agent that calls back into T3 Code needs a public endpoint on every environment,
  and can only speak in reply to the user. A finished worker could not announce itself.
- A speech-to-speech model would be a second brain beside the voice thread.

Outbound-only also means local, Tailscale and T3 Connect environments behave the same, and the API
key never reaches a client.

## Constraints

- **The voice thread is the only brain.** A finished user turn is one `message.dispatch` with
  `deliveryIntent: "auto"`, prefixed `[voice]`. Nothing here calls a model, and no other thread
  may speak.
- **The router brief travels with the spoken turn.** A spoken message that starts a run is sent to
  the provider with the router instructions in front of it
  ([`routerBrief.ts`](../../apps/server/src/voice/routerBrief.ts)); the stored message is
  unchanged. No provider has a per-thread instruction slot, so this is the one place that reaches
  all of them, and repeating it per run survives compaction. Typed messages are left alone so
  `/compact` and worker reports keep their exact text.
- **Two ways to be heard, never both.** The thread's finished written replies are read aloud by
  the service (`speakReplies`), so any model works without knowing about voice. A thread that
  calls `voice_say` instead is not also read aloud for that turn. Reading aloud keys on finished
  `message.updated` events; streaming updates are ignored, so speech starts when a message
  completes, not as it is typed.
- **One fiber owns a session's state.** Speech events, client frames, `voice_say` calls and timers
  all enter one queue ([`VoiceSession.ts`](../../apps/server/src/voice/VoiceSession.ts)). Do not
  read or change session state from another fiber; send an input.
- **Barge-in needs words, not sound.** Only transcript text that is not a listening sound
  ("mm-hm", or "yeah" said over the bot) cuts the bot off. Voice activity alone would let the bot
  interrupt itself through the speakers.
- **What was heard comes from the client.** After a cut-off the server tells the client to drop
  its buffer and asks how many milliseconds played. Character timings from the speech service turn
  that into the words reported to the voice thread. The server's own clock is only the fallback.
- **Fail closed before audio leaves.** A session starts only after the key resolves through
  `requireSettingsSecret`. The host is chosen from a closed list, and the voice and model ids are
  validated in the contract, because all three are placed in the URL the key is sent to.
- **Zero retention is a promise.** If the user asked for it and ElevenLabs reports it was not
  applied, the session ends instead of continuing.
- **The client never buffers microphone audio.** A frame that cannot be sent now is dropped.
  Late speech would be transcribed after the moment it belonged to and interrupt the wrong thing.
- **A cleared speech stays cleared.** The playback buffer drops frames for a speech id it has
  cleared, because audio already on the wire arrives after the `clear`.
- **Other threads report through the notification channel.** [VoiceWatch](../../apps/server/src/voice/VoiceWatch.ts)
  queues ordinary runs and side chats from their run events, and delegated results
  from the parent's task record after settlement. The remote follower records
  results on the parent but leaves live requests on the executing environment.
  The voice thread's own delegated results use the existing completion channel.
  Stable command ids deduplicate each report. The cursor starts at the log tail
  on first startup and resumes from retained events on later starts. A settled
  request can cancel its queued notice on the original destination using its
  command receipt, including after a restart or a change of voice thread.
- **Memory is the voice thread's.** [`MemoryService.ts`](../../apps/server/src/memory/MemoryService.ts)
  refuses other threads, because anything written there is read back into a later conversation.
  The secret filter runs on every write and errs toward refusing.
- **The watchdog's judgement is code.** [`VoiceWatchdog.ts`](../../apps/server/src/voice/VoiceWatchdog.ts)
  decides what is stalled from recorded timestamps and tells each finding once. The scheduled agent
  that calls it only relays. The server never creates that task: every run of it spends the user's money.
  The told-once marks and the conversation failure log live in memory, so a restart repeats a
  finding that is still true and forgets failures that were never read.
- **Two speech sockets, chosen by model.** Flash and Multilingual speak through ElevenLabs'
  multi-context socket, where barge-in closes a context. Eleven v3 and v4 models are refused there
  and speak only through the single-stream Text to Dialogue socket, which has no contexts, so
  [`ElevenLabsVoice.ts`](../../apps/server/src/voice/ElevenLabsVoice.ts) opens one connection per
  speech and closes it to interrupt. That costs a handshake per sentence; do not "fix" it by keeping
  one dialogue connection open, because then nothing can stop a sentence mid-way.
- **Live captions are not history.** Partial words exist only in the conversation socket's state
  and the strip above the composer. The saved record is the `[voice]` user message and the
  thread's own reply, both written by the normal orchestration path, so nothing voice-specific
  can duplicate or lose a message. A reload ends the conversation and loses only captions.
- **The `[voice]` marker is for the agent, not the reader.** It stays in the stored text so the
  agent knows a turn was spoken. Clients drop it in `resolveUserMessagePresentation`, keyed on the
  `voice-message:` id prefix, not on the text, so a typed message that starts the same way is shown
  as written. Do not strip it at dispatch: the agent would lose the signal.
