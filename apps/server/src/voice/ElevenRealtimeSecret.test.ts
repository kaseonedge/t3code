import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { mintElevenRealtimeSecret } from "./ElevenRealtimeSecret.ts";

it.effect(
  "requests a bounded Mini session with the selected voice and returns only the ephemeral value",
  () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          assert.equal(request.url, "https://api.elevenlabs.io/v1/convai/realtime/client_secrets");
          assert.equal(request.method, "POST");
          assert.equal(request.headers["xi-api-key"], "fixture-permanent");
          assert.isTrue(request.body._tag === "Uint8Array");
          if (request.body._tag === "Uint8Array") {
            const body = JSON.parse(new TextDecoder().decode(request.body.body));
            assert.equal(body.expires_after.seconds, 60);
            assert.equal(body.session.model, "eleven_realtime_v1_mini");
            assert.equal(body.session.max_duration_seconds, 300);
            assert.equal(body.session.audio.input.format.rate, 24_000);
            assert.equal(body.session.audio.output.voice, "fixture-voice");
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              value: "fixture-ephemeral",
              expires_at: 60,
            }),
          );
        }),
      );
      const value = yield* mintElevenRealtimeSecret(
        Redacted.make("fixture-permanent"),
        "fixture-voice",
      ).pipe(Effect.provideService(HttpClient.HttpClient, client));
      assert.equal(value, "fixture-ephemeral");
    }),
);

it.effect("reports a sanitized configuration error without surfacing provider details", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ detail: "sensitive fixture returned by provider" }, { status: 422 }),
        ),
      ),
    );
    const result = yield* mintElevenRealtimeSecret(
      Redacted.make("fixture-key"),
      "fixture-voice",
    ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);
    assert.equal(result.reason, "realtime-configuration-rejected");
    assert.notInclude(result.message, "sensitive fixture");
  }),
);
