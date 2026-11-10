import { expect, it } from "vite-plus/test";
import { looksLikeSecret } from "./secretFilter.ts";

const fake = (...parts: ReadonlyArray<string>) => parts.join("");

it.each([
  // Built from parts so no scanner mistakes these fixtures for real credentials.
  ["an OpenAI-style key", fake("the key is sk-", "proj-", "abcdefghijklmnop1234")],
  ["a GitHub token", fake("use gh", "p_", "0123456789abcdefghijABCDEFGHIJ")],
  ["a Slack token", fake("xox", "b-", "1234567890-abcdefghij")],
  ["an AWS access key id", fake("AKIA", "IOSFODNN7EXAMPLE")],
  ["a private key block", "-----BEGIN RSA PRIVATE KEY-----"],
  [
    "a JSON web token",
    fake("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "abcd1234"),
  ],
  ["a bearer header", "send Authorization: Bearer abcdefghijklmnop1234"],
  ["a URL with a password", "db is postgres://admin:hunter22@db.acme.test/app"],
  ["a spoken password", "Simon's wifi password is hunter2rocks"],
  ["an assigned token", "STAGING_API_KEY=abc123def456"],
  ["a bare generated string", fake("it is ", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG")],
])("refuses %s", (_name, text) => {
  expect(looksLikeSecret(text)).toBe(true);
});

it.each([
  ["a preference", "Simon prefers short spoken answers and no pull request without asking."],
  ["where a secret lives", "The ElevenLabs API key is kept in 1Password under Work/Voice."],
  ["a secret's status", "The deploy token is rotated every Monday by the infra thread."],
  ["a thread id", "The auth fix lives in thread 9198824b-6f82-420f-9aa6-f301ca4ec6ba."],
  ["a commit", "The login regression came in with commit ce82d7c80a on Tuesday."],
  ["a path", "Voice code is under apps/server/src/voice/VoiceSessionService.ts."],
  ["a decision", "We decided the password reset flow stays on the old provider until March."],
])("keeps %s", (_name, text) => {
  expect(looksLikeSecret(text)).toBe(false);
});
