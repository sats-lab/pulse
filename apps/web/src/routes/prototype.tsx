import { createFileRoute, redirect } from "@tanstack/react-router";

import { RemoteAccessManagementPrototype } from "../components/prototype/RemoteAccessManagementPrototype";

export const Route = createFileRoute("/prototype")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: RemoteAccessManagementPrototype,
});
