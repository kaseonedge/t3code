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
3. **Voice thread.** Pick the one thread that hears you and answers. Use a
   thread you keep for this purpose: it does the talking and hands longer work
   to other threads.
4. **Allow on this device.** While a conversation is on, this device's
   microphone audio goes through the environment to ElevenLabs, and the bot's
   speech comes back the same way. This is separate from the dictation setting,
   and turning it off ends a running conversation at once.

Press **Start**. A live conversation shows in the sidebar wherever you are in
the app, with **End** beside it.

Use headphones if you can. Through speakers the bot can hear itself, and your
browser's echo cancellation does not always catch it.

## Talk

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

## Hear about other work

Work the voice thread starts itself is reported to you when it finishes. To
hear about threads it did not start, add them under **Watched threads**, or ask
the bot to watch one. Remove a thread from the list to stop.

## Memory

The voice thread can remember lasting facts, your preferences, and decisions,
and recall them in later conversations. **Memory** in the same section lists
everything it has saved, where each entry came from, and lets you delete any of
them. Passwords, keys, and tokens are refused.

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
