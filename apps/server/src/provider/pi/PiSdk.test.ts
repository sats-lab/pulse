import { describe, expect, it } from "vite-plus/test";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Compile/runtime characterization for the exact Pi SDK version pinned by the
 * server. It intentionally avoids network/auth requirements.
 */
describe("Pi 0.82 SDK", () => {
  it("creates and refreshes a ModelRuntime and creates an in-memory session", async () => {
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    });

    expect(Array.isArray(runtime.getProviders())).toBe(true);
    expect(Array.isArray(runtime.getModels())).toBe(true);
    expect(Array.isArray(runtime.getAvailableSnapshot())).toBe(true);
    expect(runtime.getModel("missing", "missing")).toBeUndefined();
    expect(await runtime.checkAuth("missing")).toBeUndefined();

    const refresh = await runtime.refresh({ allowNetwork: false });
    expect(refresh).toBeDefined();

    const { session } = await createAgentSession({
      modelRuntime: runtime,
      noTools: "all",
      sessionManager: SessionManager.inMemory(),
    });
    expect(session.sessionId.length).toBeGreaterThan(0);
    expect(typeof session.subscribe).toBe("function");
    expect(typeof session.prompt).toBe("function");
    session.dispose();
  });
});
