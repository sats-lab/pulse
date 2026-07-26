import type { DesktopBridge, DesktopWslState, ServerAuthPolicy } from "@t3tools/contracts";

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

export function shouldIncludePrimaryAccessEnvironment(input: {
  readonly desktopMode: boolean;
  readonly desktopRemotelyReachable: boolean;
  readonly authPolicy: ServerAuthPolicy | null;
}): boolean {
  return input.desktopMode
    ? input.desktopRemotelyReachable
    : input.authPolicy === "remote-reachable";
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}
