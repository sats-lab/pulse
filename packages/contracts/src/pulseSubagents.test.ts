import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PulseSubagent, SubagentCreateCommand, SubagentCreatedPayload } from "./pulseSubagents.ts";

const subagent = {
  id: "subagent-1",
  origin: {
    projectId: "project-1",
    threadId: "thread-1",
    turnId: "turn-1",
  },
  title: "Test subagent",
  prompt: "Do the work",
  metadata: { providerInstanceId: "provider-1", model: "model-1" },
  thinking: "medium",
  effort: "high",
  status: "created",
  delivery: "none",
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies typeof PulseSubagent.Encoded;

const command = {
  type: "subagent.create",
  commandId: "command-1",
  subagentId: subagent.id,
  subagent,
} satisfies typeof SubagentCreateCommand.Encoded;

it.effect("decodes the create command and created payload", () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(SubagentCreateCommand)(command);
    const payload = yield* Schema.decodeUnknownEffect(SubagentCreatedPayload)({ subagent });
    assert.strictEqual(decoded.subagent.id, "subagent-1");
    assert.strictEqual(payload.subagent.origin.threadId, "thread-1");
  }),
);

it("rejects malformed and forged aggregate input", () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(SubagentCreateCommand)({ ...command, type: "wrong" }),
  );
});
