import { assert, it } from "@effect/vitest";

import { formatServiceStatus } from "./service.ts";

const status = {
  supported: true,
  installed: true,
  current: true,
  port: 3773,
  unitPath: "/home/me/.config/systemd/user/pulse.service",
  logPath: "/home/me/.t3/userdata/logs/boot-service.log",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29"),
    [
      "Pulse service",
      "  Status: installed · @sats-lab/pulse@0.0.29",
      "  Unit: /home/me/.config/systemd/user/pulse.service",
      "  Port: 3773",
      "  Logs: /home/me/.t3/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("gives a direct repair command for a stale service", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `npx @sats-lab/pulse@latest service update`.",
  );
});

it("explains service availability without systemd", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd",
  );
});
