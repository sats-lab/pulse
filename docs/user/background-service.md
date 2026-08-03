# Running Pulse in the Background

On a Linux host, Pulse can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

## Manage the Service

Install it with the latest Pulse release. The host defaults to `0.0.0.0` and the port defaults to
`3773`. Pass `--host` or `--port` to choose different values:

```sh
npx @sats-lab/pulse@latest service install --host 0.0.0.0 --port 3773
```

Running `service install` again with a different host or port reconfigures and restarts the existing
service. Both values are stored in `~/.t3/service.json` by default. Running `service update` without
explicit values preserves them.

Check whether it is installed:

```sh
npx @sats-lab/pulse@latest service status
```

Update or repair it:

```sh
npx @sats-lab/pulse@latest service update
```

Stop it and remove it from startup:

```sh
npx @sats-lab/pulse@latest service uninstall
```

Installing, reconfiguring, or updating restarts Pulse briefly. Let active agent work and terminal
commands finish first.

The systemd unit is named `pulse.service` and runs a small stable launcher. Installing or updating
migrates the previous `t3code.service` unit automatically. Exact Pulse versions are installed separately, so
a failed remote candidate can return to the previous version without rewriting the unit. When the
command is run from an installed local package, setup first pins that package and falls back to the
npm registry if the local copy cannot be installed. Releases that change the database must be
installed with the local `service update` command above.

## Using It with T3 Connect

T3 Connect may offer to install the service during setup so the host stays reachable after you log
out. This is only an onboarding shortcut: the service and T3 Connect are managed separately.

Signing out of T3 Connect does not remove the service. Use `pulse service uninstall` when you no
longer want Pulse to start in the background.

The background service currently requires Linux with systemd.
