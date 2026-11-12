# Voice conversation

Talk with one thread and hear it answer. Unlike [dictation](./voice-input.md),
which only fills in the composer, a voice conversation is live in both
directions: you can interrupt the bot mid-sentence, and it can speak up when
work it started finishes. It is available in the web and desktop apps.

Voice conversations use [ElevenLabs](https://elevenlabs.io) for speech
recognition and speech. You need your own ElevenLabs API key.

## Set it up

Open **Settings → Voice → Conversation**.

1. **ElevenLabs API key.** It is saved on the environment and never shown
   again. You can point it at a [secret provider](./secrets.md) instead of
   pasting it. Anyone who can talk to that environment can bill the key.
2. **Voice.** Paste the voice ID from your ElevenLabs voice library.
   **Speech model** chooses how the bot sounds: Flash v2.5 (the default, fastest
   and cheapest) or v4 Turbo (more natural, costs more per character, and your
   ElevenLabs plan must include it).
3. **Voice thread.** Pick the one thread that hears you and answers. Use a
   thread you keep for this purpose: it does the talking and hands longer work
   to other threads.
4. **Allow on this device.** While a conversation is on, this device's
   microphone audio goes through the environment to ElevenLabs, and the bot's
   speech comes back the same way. This is separate from the dictation setting,
   and turning it off ends a running conversation at once.

Press **Start**, or use the voice conversation button beside the dictation
microphone in any thread's composer on that environment. The button is filled
while a conversation is on, and pressing it again ends it. Until setup is
complete it opens these settings instead. A live conversation also shows in the
sidebar wherever you are in the app, with **End** beside it.

The composer button does not change dictation: the microphone beside it still
fills in your draft.

Use headphones if you can. Through speakers the bot can hear itself, and your
browser's echo cancellation does not always catch it.

## Talk

Your words appear above the composer as you say them, and each finished phrase
is saved to the voice thread as one of your own messages. The thread's reply
appears there as it is written and is read aloud when it is complete. From
another thread, the same strip shows what the bot is saying. Long replies are
read up to about half a minute, then "The rest is in the thread." If a turn fails
or finishes with nothing to read out, the bot says so instead of staying silent.

Just speak. The bot is cut off as soon as you say real words; listening sounds
such as "mm-hm" do not interrupt it. These phrases are handled on the spot,
without waiting for the thread:

| Say                    | What happens                                           |
| ---------------------- | ------------------------------------------------------ |
| "Stop"                 | Stops speaking and drops anything waiting to be said   |
| "Quiet"                | Stops speaking and holds news until you say "go ahead" |
| "Go ahead" or "resume" | Lets held news play                                    |
| "Repeat that"          | Says the last thing again                              |
| "Louder" or "quieter"  | Changes the volume on this device                      |

The bot keeps what it says short. Ask it to go into detail and it will, a
couple of sentences at a time; the full text is always in the voice thread.

**When your turn is heard** sets how this device confirms it heard you before
an answer is ready: a short tone, an on-screen "Heard you", or nothing.

## Realtime conversation

In an existing thread, choose **Realtime** beside the standard voice button to
try Eleven Realtime Mini. The conversation can continue while a request runs in
that thread. Ask for the status of an accepted request at any time. Review any
approval in T3 Code. Interrupting speech leaves accepted work running.

Realtime uses the configured ElevenLabs voice and requires workspace access to
the Realtime API. Connected time may be billed, and a session lasts up to five
minutes. Use the standard voice button to return to the original conversation
mode. Realtime is available with the global endpoint and requires zero retention
to be off.

## Hear about other work

The voice thread reports finished runs and requests for your approval or answer
in this environment. Reports include a link to the source, including side chats
and delegated work. Open the link to review and act on an approval. Reports
appear in the voice thread and can be read aloud during a conversation.

For work delegated to a linked environment, the originating environment reports
the result when it receives it. Live approvals and questions surface in the
environment where they are requested. The voice thread receives results from
its own delegated work through the usual task channel.

Each report uses a model turn. To hear about fewer threads, turn off **Report
thread activity** in **Settings → Voice → Conversation** and add threads under
**Watched threads**, or ask the bot to watch one.

## Memory

The voice thread can remember lasting facts, your preferences, and decisions,
and recall them in later conversations. **Memory** in the same section lists
everything it has saved, where each entry came from, and lets you delete any of
them. Passwords, keys, and tokens are refused.

## Watchdog

A long conversation can go wrong quietly: the voice thread hangs, a worker
stops making progress, or ElevenLabs rejects the key. A watchdog thread can
notice and tell the voice thread, which tells you.

1. In **Settings → Voice → Conversation**, choose a **Watchdog thread**. Use a
   separate thread on a cheap model. Choosing it does nothing by itself.
2. In **Settings → Scheduled tasks**, add a task on that thread that repeats
   every few minutes with a prompt such as: "Call `voice_health`. If there are
   no findings, stop. Otherwise send the voice thread one line per finding."

Each scheduled run starts an agent turn, which costs what that provider
charges, so T3 Code never creates this task for you. The check itself costs
nothing and reports each problem once, and again only if it clears and comes
back. To stop, delete the task; set **Watchdog thread** back to None to remove
its access.

It reports a voice thread with nothing new for 10 minutes, a worker or watched
thread with nothing new for 20 minutes, and failed conversations.

## Privacy

**Zero retention** asks ElevenLabs not to keep your audio or text. ElevenLabs
offers this on some plans only. If you turn it on and your plan does not allow
it, the conversation stops instead of carrying on with retention.

## Troubleshoot

- **Start is disabled.** The line beside it names what is missing.
- **"Couldn't read the ElevenLabs API key."** Unlock the vault on the
  environment, or save the key again.
- **"A voice conversation is already running."** Each environment holds one
  conversation at a time. End the other one first.
- **The bot interrupts itself.** Use headphones.
