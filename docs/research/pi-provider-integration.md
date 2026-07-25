# Pi Provider integration research

This note documents how the older fork at `oxygen:~/Code/t3code` integrates Pi, how Pi flows through the server and client, and what must change to integrate it into this checkout.

## Scope and source versions

Primary sources inspected:

- Older fork: `oxygen:~/Code/t3code`, HEAD `0c7dc57b6f5286c67418991b86962dd21c4af258`
- Current checkout: `/home/chan/Code/t3code`, HEAD `5719e8ac4020dda0e375ef61d044b61f55a0df8a`
- Official Pi source vendored by the older fork: `oxygen:~/Code/t3code/.repos/pi`
- Older Pi introduction commit: `3a4e69f0e9b01a891bc5e32d2f1d454908e83e85` (`Add Pi SDK provider driver and adapter`)
- Important follow-up commits:
  - `863a034d5` — session persistence/resume
  - `66fe45154` — steer/follow-up and stop/interrupt handling
  - `5f00e0e38` — Codex-parity event work
  - `32b0af5d6` — tool-call presentation
  - `1649e8bd1` — skills
  - `edcf76a49` — compaction
  - `9be8e9253` — provider environment and aborted-tool recovery fixes
  - `8a363856e` — adapter hardening
  - `06855d981` — runtime model/skill/command discovery
  - `4ef2e0f9c` — live assistant streaming repair

The older server declares `@earendil-works/pi-coding-agent: ^0.79.6`; its lock resolves `0.79.10`, while its vendored Pi package reports `0.79.3`. That code is historical reference only. The target integration must use Pi `0.8x`; as of this research, npm `latest` is `0.82.0` and the locally installed CLI is `0.81.1`. Pin `0.82.0` (or the exact reviewed `0.8x` release current when implementation begins), and sync/read source for that exact version.

## Target Pi 0.8x baseline

The implementation baseline is Pi `0.8x`, not the old fork's `0.79.x` package. At the time of this update:

- npm `latest`: `@earendil-works/pi-coding-agent@0.82.0`
- locally installed Pi: `0.81.1`
- recommended implementation pin: exact `0.82.0`

The major porting boundary is Pi `0.80.8`:

| Old integration API                                  | Pi `0.82.0` replacement                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `AuthStorage.create(...)`                            | `ModelRuntime.create({ authPath, ... })` or a custom credential store                     |
| `ModelRegistry.create(...)`                          | `ModelRuntime.create({ modelsPath, modelsStorePath, ... })`                               |
| `createAgentSession({ authStorage, modelRegistry })` | `createAgentSession({ modelRuntime })`                                                    |
| `createAgentSessionServices({ modelRegistry })`      | `createAgentSessionServices({ modelRuntime })`                                            |
| synchronous `modelRegistry.refresh()`                | async `await modelRuntime.refresh()`                                                      |
| `modelRegistry.find(...)`                            | `modelRuntime.getModel(...)`                                                              |
| `modelRegistry.getAvailable()`                       | async `modelRuntime.getAvailable()` or `getAvailableSnapshot()`                           |
| `modelRegistry.hasConfiguredAuth(model)`             | `modelRuntime.hasConfiguredAuth(providerId)`, `checkAuth()`, or `getProviderAuthStatus()` |
| `modelRegistry.getProviderDisplayName(...)`          | provider metadata from `modelRuntime.getProvider(s)`                                      |

Core session APIs used by the old adapter remain present in `0.82.0`: `createAgentSession`, `subscribe`, `prompt` with steer/follow-up, `setModel`, `setThinkingLevel`, `compact`, `reload`, `clearQueue`, `abort`, `bindExtensions`, `dispose`, and `SessionManager.open/branch/resetLeaf/buildSessionContext`.

Pi `0.82.0` also adds/changes event and capability details that the adapter should handle deliberately:

- `bash_execution_update` is now part of `AgentSessionEvent` for correlated streaming direct-bash output.
- compaction/branch-summary retry lifecycle events are present.
- `max` reasoning exists in addition to `xhigh`; do not hard-code the old five-level list.
- model/provider catalogs are dynamic and refresh is async.
- extensions can register complete providers; runtime discovery should read the live `ModelRuntime` after extension binding/reload.

## Executive summary

Pi is integrated as a normal provider driver using the Pi TypeScript SDK, not by spawning `pi --mode rpc`.

The server architecture is:

```text
Pi SDK AgentSession
  -> PiAdapter converts AgentSessionEvent to ProviderRuntimeEvent
  -> ProviderService merges all instance event streams
  -> ProviderRuntimeIngestion converts canonical events to orchestration commands
  -> projections/WebSocket/client state
  -> generic chat, work-log, model, command, skill, queue, and status UI
```

In the opposite direction:

```text
client/orchestration intent
  -> ProviderCommandReactor
  -> ProviderService routes by ProviderInstanceId
  -> PiAdapter startSession/sendTurn/interrupt/stop
  -> Pi AgentSession
```

Most orchestration is intentionally provider-neutral. The Pi-specific work is concentrated in:

- `apps/server/src/provider/Drivers/PiDriver.ts`
- `apps/server/src/provider/Layers/PiProvider.ts`
- `apps/server/src/provider/Layers/PiAdapter.ts`
- `apps/server/src/provider/Layers/PiPulseTools.ts`
- `apps/server/src/textGeneration/PiTextGeneration.ts`

Client support is mostly registration and presentation metadata plus generic provider discovery. However, queue/follow-up visibility and the discovery RPCs require contract and orchestration additions that are absent from the current checkout.

## 1. Server registration and composition

### 1.1 Driver registration

The older fork adds `PiDriver` to `apps/server/src/provider/builtInDrivers.ts` and includes `PiDriverEnv` in `BuiltInDriversEnv`. This makes Pi participate in the same `ProviderInstanceRegistry` lifecycle as Codex, Claude, Cursor, Grok, and OpenCode.

`apps/server/src/provider/Drivers/PiDriver.ts` declares:

- driver kind: `ProviderDriverKind.make("pi")`
- display name: `Pi`
- `supportsMultipleInstances: true`
- config schema: `PiSettings`
- continuation identity: the default per-instance identity, effectively `pi:instance:<instanceId>`

The per-instance continuation key matters: two Pi instances are intentionally incompatible for continuation in an existing thread. The generic `ProviderCommandReactor` rejects a switch when continuation keys differ.

### 1.2 Per-instance SDK state

The old `PiDriver.create` creates one `AuthStorage` and one `ModelRegistry` per Pi provider instance. **Do not copy that construction into the target implementation:** Pi `0.80.8` removed `CreateAgentSessionOptions.authStorage` and `.modelRegistry` in favor of the async `ModelRuntime` API. The `0.82.0` implementation should create one `ModelRuntime` per Pi provider instance, configured with the instance's auth/model paths and then passed to `createAgentSession(...)` / `createAgentSessionServices(...)`.

It then creates three instance-owned closures:

1. `makePiAdapter(...)` — interactive session lifecycle and runtime events
2. `makePiTextGeneration(...)` — branch/title/commit/PR text generation
3. `makeManagedServerProvider(...)` — provider snapshot/probe stream

The resulting `ProviderInstance` is the same shape as other drivers: `snapshot`, `adapter`, `textGeneration`, identity, enabled state, and presentation fields. This follows the current SPI in `apps/server/src/provider/ProviderDriver.ts`.

### 1.3 Provider snapshot and status

`apps/server/src/provider/Layers/PiProvider.ts` builds the Pi provider snapshot.

Presentation policy in the older fork:

- `showInteractionModeToggle: false`
- `supportedAccessModes: ["full-access"]`
- `deferMidTurnUserMessages: true`

The provider probe is SDK/model-auth based, not binary based. In the old code it uses `ModelRegistry`; in Pi `0.82.0` it should use `ModelRuntime`:

- await `ModelRuntime.getAvailable()` when a fresh availability check is required, or use `getAvailableSnapshot()` after initialization/refresh
- use `getError()` for availability/catalog warnings
- use `getProviders()`, `getModels()`, and `getModel()` for provider/model lookup
- use `checkAuth()` / `getProviderAuthStatus()` for provider authentication state
- obtain display labels from live provider metadata rather than the removed `getProviderDisplayName()` helper
- model slugs remain `provider/model`
- derive thinking options from the model's current `0.82` capability metadata, including `max` where supported, rather than the old handwritten assumptions

The snapshot also exposes:

- Pi skills loaded through Pi resource discovery
- `/reload`
- `/compact [optional instructions]`

The managed snapshot refresh interval is five minutes, while runtime discovery can refresh models/resources on demand.

### 1.4 Settings

The older `packages/contracts/src/settings.ts` defines `PiSettings` with:

- `enabled`, default `true`
- `agentDir`, blank meaning Pi's default `~/.pi/agent`
- `midTurnInputMode: "steer" | "followUp"`, default `steer`
- hidden `noTools: "" | "all" | "builtin"`
- hidden `tools: string[]`
- hidden `excludeTools: string[]`

It adds Pi to both:

- legacy `ServerSettings.providers.pi`
- `ServerSettingsPatch.providers.pi`

The instance registry's legacy hydration then synthesizes the default `pi` instance unless an explicit `providerInstances.pi` exists. The current checkout's `ProviderInstanceRegistryHydration.ts` already implements this generic built-in-driver hydration, but `PiSettings` and `providers.pi` are absent.

## 2. Pi SDK usage

The older fork uses the official Pi SDK directly. The relevant official APIs are documented/implemented in the vendored Pi sources:

- `.repos/pi/packages/coding-agent/docs/sdk.md`
- `.repos/pi/packages/coding-agent/src/core/sdk.ts`
- `.repos/pi/packages/coding-agent/src/core/agent-session.ts`
- `.repos/pi/packages/coding-agent/src/core/session-manager.ts`
- `.repos/pi/packages/coding-agent/src/core/model-registry.ts`
- `.repos/pi/packages/coding-agent/src/core/auth-storage.ts`

Important SDK behavior used by T3, updated for Pi `0.82.0`:

- `ModelRuntime.create(...)` is async and owns credentials, model configuration, provider catalogs, authentication, and refresh. The old `AuthStorage`/`ModelRegistry` session options are gone.
- `createAgentSession(...)` accepts cwd, agentDir, `modelRuntime`, selected model, session manager, custom tools, and tool allow/deny policy.
- `createAgentSessionServices(...)` also accepts `modelRuntime` and returns it with the resource loader/settings manager.
- model runtime lookup now uses `getProviders()`, `getModels()`, `getModel()`, `getAvailable()`, `checkAuth()`, and `refresh()`.
- the default resource loader discovers extensions, skills, prompts, settings, models, auth, and context files.
- `session.subscribe(listener)` streams message, tool, queue, compaction, retry, and session events.
- `session.prompt(...)` supports images and `streamingBehavior: "steer" | "followUp"`.
- `session.setModel(...)` and `setThinkingLevel(...)` allow in-session model option changes.
- `session.compact(...)`, `reload()`, `abort()`, `clearQueue()`, and `dispose()` provide lifecycle operations.
- `SessionManager` stores an append-only JSONL conversation tree and supports `open`, `branch`, `resetLeaf`, and `buildSessionContext`.

This is why the integration uses SDK sessions rather than translating Pi CLI/RPC output.

## 3. PiAdapter session lifecycle

`apps/server/src/provider/Layers/PiAdapter.ts::makePiAdapter` is the core integration. It owns:

- `Map<ThreadId, PiSessionContext>`
- a `PubSub<ProviderRuntimeEvent>`
- one Pi `AgentSession` and Effect scope per active thread
- active turn, assistant/reasoning item, tool-call, compaction, and queue state

### 3.1 Start/resume

`startSession`:

1. Validates the requested provider kind.
2. Stops any previous Pi context for the thread.
3. Resolves cwd and selected `provider/model` from the instance `ModelRegistry`.
4. Extracts a Pi session file from the opaque T3 `resumeCursor`.
5. Opens that file with `SessionManager.open(...)`, or lets Pi create a new persisted session.
6. Creates custom T3/Pulse tools.
7. Calls `createAgentSession(...)` with the configured tool policy and provider environment. For Pi `0.82.0`, this call must pass the instance `ModelRuntime`, not the removed `authStorage`/`modelRegistry` fields.
8. Calls `session.bindExtensions({})`.
9. Subscribes to Pi events.
10. Stores a T3 `ProviderSession` containing cwd, model, provider instance, and a resume cursor derived from Pi's session file/id.
11. Emits canonical `session.started`, `thread.started`, and initial token-usage events.

The resume cursor is intentionally opaque to orchestration but Pi-specific inside the adapter. Server database history alone is not sufficient to resume; the Pi JSONL session file must still exist and be readable.

### 3.2 Turns

`sendTurn`:

- creates a T3 provider turn id
- materializes image attachments from the attachment store into Pi base64 image inputs
- validates that text or images exist
- switches the Pi model and thinking level in-session
- emits `turn.started`
- runs `session.prompt(...)` in the session scope
- emits token usage and `turn.completed` after the accepted Pi run settles
- maps terminal Pi assistant errors/aborts into failed/interrupted completion state

Special command handling:

- `/reload` invokes `session.reload()` and emits a synthetic turn lifecycle.
- `/compact [instructions]` invokes `session.compact(...)`, projects context-compaction state, and then drains messages queued during compaction.

Mid-turn input:

- The current port intentionally removes the older provider setting for choosing one fixed mid-turn behavior.
- If a turn is already active, Enter sends steering input and Alt/Option+Enter sends follow-up input through `session.prompt(text, { streamingBehavior })`.
- Pi emits `queue_update`; the adapter maps that to `input.queue.updated` with separate `steering` and `followUp` arrays.
- while manual or automatic compaction is active, the adapter holds a parallel queue, merges it into canonical queue snapshots, and submits it after compaction through public `AgentSession.prompt(...)`, `steer(...)`, and `followUp(...)` APIs.

### 3.3 Interrupt and teardown

`interruptTurn`:

- clears adapter turn state
- clears Pi's queued messages and the adapter-owned compaction queue
- calls `session.abortCompaction()` and `session.abort()`
- emits `turn.aborted`
- emits `turn.completed` with `interrupted`

`stopContext`:

- atomically marks the context stopped
- interrupts the active Effect fiber
- unsubscribes from Pi events
- calls `session.dispose()`
- closes the session scope

`stopSession` removes one thread context and emits `session.exited`; `stopAll` tears down all sessions owned by that provider instance.

### 3.4 Read and rollback

`readThread` combines Pi message history with active adapter turn state.

`rollbackThread` removes adapter turn snapshots, moves the Pi session tree using `SessionManager.branch(...)` or `resetLeaf()`, then replaces Pi agent messages from `buildSessionContext().messages`.

This is a provider-native implementation behind the generic `ProviderAdapterShape` methods.

## 4. Event normalization and orchestration

### 4.1 Pi event mapping

Pi emits callback events. `handleSessionEvent` converts them to the canonical `ProviderRuntimeEvent` protocol. When porting to `0.82.0`, make the event switch exhaustive against the pinned `AgentSessionEvent` union and add an explicit mapping or intentional ignore case for new events such as `bash_execution_update` and summarization retry lifecycle events.

Key mappings:

| Pi `AgentSessionEvent`          | Canonical T3 event                                               |
| ------------------------------- | ---------------------------------------------------------------- |
| `message_start` for assistant   | `item.started` / `assistant_message`                             |
| `message_update.text_delta`     | `content.delta` / `assistant_text`                               |
| `message_update.thinking_delta` | reasoning `item.started` plus `content.delta` / `reasoning_text` |
| `message_end` for assistant     | assistant/reasoning `item.completed`                             |
| `tool_execution_start`          | tool `item.started`                                              |
| `tool_execution_update`         | tool-output `content.delta` and structured `item.updated`        |
| `tool_execution_end`            | tool `item.completed`                                            |
| `queue_update`                  | `input.queue.updated`                                            |
| `session_info_changed`          | `thread.metadata.updated`                                        |
| compaction events               | `context_compaction` item lifecycle and thread state             |
| retry events                    | runtime warning/error activity                                   |
| terminal assistant error/abort  | failed/interrupted turn state                                    |

Tool classification is presentation-aware:

- bash/command-like tools -> `command_execution`
- edit/write -> `file_change`
- remaining tools -> `dynamic_tool_call` or another canonical type where available

The adapter tracks accumulated tool text and structured partial-result state so incremental updates patch one tool row instead of creating unrelated rows.

### 4.2 Tool-output deltas and the quadratic-growth problem

Yes: the older fork contains two explicit delta layers added by `ddae51d47` (`Stream Pi tool output as content deltas`) and `9bba512dd` (`Stream Pi tool result deltas into work log entries`). They address a real O(n²) **wire/storage** problem caused by Pi tool updates carrying cumulative snapshots:

- `lastOutputText` plus `diffAccumulatedPiToolOutput(...)` emits only the new text suffix as canonical `content.delta`.
- `lastPartialResult` plus `diffPiJsonValue(...)` emits `partialResultDelta` / `resultDelta` patches instead of embedding the entire structured result in every `item.updated` activity.
- the web client reconstructs the structured partial/final result by applying those patches per `toolCallId`.

Without this, output snapshots of sizes `1, 2, 3, ... n` produce O(n²) transferred and persisted bytes.

However, the old implementation does **not** fully solve the complexity problem and should not be copied unchanged:

- `diffAccumulatedPiToolOutput` calls `next.startsWith(previous)`, which can rescan the growing prefix on every update: O(n²) CPU across an unbounded cumulative stream.
- `jsonEqual` performs `JSON.stringify(previous) === JSON.stringify(next)` before recursively diffing; cumulative structured results can therefore still cost O(n²) CPU even though emitted patches are compact.
- when a text snapshot no longer starts with the prior snapshot, the fallback emits the whole `next` string as an append-only `content.delta`. For a rolling/truncated tail, that can duplicate already-rendered output and repeatedly send the entire display window.
- the old client reconstructs deltas while iterating activity history. If that full derivation reruns after every new update, total client work can again become quadratic in the number/size of updates.

Pi `0.82.0` makes this particularly important. Its built-in bash tool throttles updates to roughly 100 ms and emits a cumulative `OutputAccumulator.snapshot()`. The accumulator bounds the displayed tail and exposes truncation metadata/full-output path, so built-in bash snapshots are bounded, but they become a rolling window after truncation and are not guaranteed to preserve the old snapshot as a prefix. Extension tools can still emit arbitrary cumulative `partialResult` values.

The `0.82` adapter should therefore use a bounded, streaming-aware projector rather than the old generic full-snapshot diff:

1. For known cumulative text tools, track byte/line progress and use Pi's truncation totals when available. Derive only newly observed output; handle rolling-tail replacement explicitly instead of treating it as an append.
2. Keep per-tool retained state bounded. Never retain or serialize an unbounded full output when Pi already provides a tail plus `fullOutputPath`.
3. For structured partial results, project only UI-relevant fields or use size/time-bounded patches. Avoid whole-object `JSON.stringify` and recursive full-tree comparison on every update.
4. Coalesce/throttle adapter events in addition to Pi's tool-level throttling, because extension tools may update faster.
5. Materialize the latest tool state in the server projection once, rather than replaying every historical patch on each client render.
6. Add stress tests that stream many chunks and assert near-linear emitted bytes/work, correct rolling-tail behavior, bounded memory, and no duplicated output after truncation.

Every event carries:

- `provider: "pi"`
- `providerInstanceId`
- thread/turn/item ids
- `raw.source: "pi.sdk.event"` with the native event payload

### 4.3 Generic orchestration

Pi does not add a separate orchestration engine.

`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` is provider-neutral:

- resolves the selected `ProviderInstanceId`
- ensures an active provider session
- enforces driver/continuation compatibility
- passes an opaque resume cursor when restarting a compatible session
- calls `ProviderService.sendTurn(...)`
- routes interrupt/stop intents

`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` consumes `ProviderService.streamEvents` and turns Pi's canonical events into the same projection commands used by other providers:

- assistant deltas/messages
- reasoning and tool activities
- token usage
- session/turn state
- queued input activity
- thread metadata and errors

Assistant streaming is controlled globally by `enableAssistantStreaming`. The old history contains a real regression fix, `4ef2e0f9c`, which changed the adapter event source from a single-consumer `Queue` to broadcast `PubSub`. This is a concrete warning: test event fan-out and live streaming through orchestration, not only the adapter in isolation.

## 5. Runtime discovery

The older fork extends the provider contract with optional composer-discovery capabilities. The current implementation ports the useful behavior through provider-neutral contracts and Pi `0.82.0` public APIs:

- `getComposerCapabilities`
- `listSkills`
- `listCommands`

The routed schemas/RPCs are:

- `ProviderDiscoveryInput`
- `ProviderListSkillsResult`
- `ProviderListCommandsResult`
- `ProviderComposerCapabilities`

The Pi adapter:

- scopes discovery to the selected provider instance, project `cwd`, and active thread/session when available
- loads skills and prompts from the active session's resource loader, or from `createAgentSessionServices(...)` using the same instance `ModelRuntime`
- merges `/reload`, `/compact`, active-session extension commands, prompt templates, and `skill:<name>` commands with deterministic built-in priority
- preserves valid partial results and returns resource-loader diagnostics separately
- converts composer `$skill` mentions to Pi's `/skill:<name>` invocation syntax
- implements `/reload` as a synthetic provider turn that reloads active-session resources without prompting the model; the composer refreshes discovery after the command is accepted

Runtime model discovery is intentionally not part of this slice because Pi models already flow through provider snapshots. Extension commands are available only when an active Pi session exists; discovery does not create a disposable model session solely to load extensions.

## 6. T3/Pulse-native tools

`apps/server/src/provider/Layers/PiPulseTools.ts` registers custom Pi SDK tools:

- `pulse_capability`
- `pulse_execute`

They let Pi discover and invoke the application's collaborative browser/preview automation. Scope includes environment id, thread id, provider instance id, provider session id, capabilities, issue time, and expiry. The older adapter gives these credentials an eight-hour validity window.

These tools are a trust boundary:

- Pi otherwise runs full-access without T3 approval prompts.
- tool allowlists/no-tools settings are merged with the custom tool names.
- preview automation must remain scoped to the intended environment/thread/session.
- snapshot output is compacted and large artifacts are saved separately.

Port this as a separately reviewed/tested unit, not as incidental adapter code.

## 7. Background text generation

`apps/server/src/textGeneration/PiTextGeneration.ts::makePiTextGeneration` provides T3's non-chat generation operations:

- commit messages
- pull request title/body
- worktree branch names
- thread titles

Each request:

1. resolves the selected Pi model through the instance `ModelRuntime` and verifies provider auth using the `0.82` APIs
2. creates an in-memory Pi session with the same `ModelRuntime` and `noTools: "all"`
3. prompts for a JSON-shaped response
4. extracts assistant text
5. decodes it through Effect Schema
6. disposes the Pi session

This path is separate from interactive chat sessions and must be added to `TextGeneration`'s provider routing/default model maps.

## 8. Client usage

### 8.1 Provider registration and presentation

The older web app adds Pi to:

- `apps/web/src/components/settings/providerDriverMeta.ts`
- `apps/web/src/components/chat/providerIconUtils.ts`
- `apps/web/src/session-logic.ts::PROVIDER_OPTIONS`
- `apps/web/src/providerInstances.ts` provider order
- `packages/contracts/src/model.ts` defaults/display names

It uses the existing `PiAgentIcon`, which still exists in the current checkout. The current add-provider dialog actually lists `piAgent` as a coming-soon option, so product naming must be decided before implementation: the older runtime/config/persisted driver key is `pi`, not `piAgent`.

The generic instance/settings UI means Pi does not require a dedicated settings page. Once `PiSettings` and the client definition exist, generic provider forms render `agentDir` and mid-turn mode.

### 8.2 Composer discovery

In the older `ChatComposer.tsx`, selecting an instance triggers `discoverProviderComposerState(...)`, which concurrently requests runtime models, commands, skills, and capabilities, then merges those results into the streamed provider snapshot.

This enables:

- provider/model picker entries discovered from Pi auth/model config
- thinking-level options
- `/reload`, `/compact`, extension commands, prompt templates, and skills in autocomplete
- per-project/per-thread resource discovery using cwd/thread id

The current checkout lacks `providerDiscoveryUi.ts` and the corresponding discovery RPCs. Server support alone will not expose Pi's dynamic resources in the composer.

### 8.3 Access and interaction controls

Pi's provider snapshot hides interaction-mode controls and restricts runtime mode to full access. This is enforced through generic presentation metadata rather than Pi checks sprinkled through the client.

### 8.4 Queued input UI

The older `ProviderRuntimeIngestion` turns `input.queue.updated` into thread activity. `ChatView.tsx` reads the latest queue activity and displays steer/follow-up items in a queued-input stack above the composer.

The current `ProviderRuntimeEvent` union does not include `input.queue.updated`, and current web code does not contain that queue card. If steer/follow-up parity is required, the canonical event, orchestration activity, projections, session logic, and client UI must be ported together.

## 9. Current-fork gaps

The current checkout is newer than the older fork and has diverged significantly. Pi itself also has a breaking SDK boundary at `0.80.8`, so the old adapter cannot compile unchanged against the required `0.8x` target. Missing pieces include:

### Server/dependency

- no `@earendil-works/pi-coding-agent` dependency; target should be exact `0.82.0` or another explicitly reviewed `0.8x` release, not `^0.79.x`
- no `PiDriver`, `PiProvider`, `PiAdapter`, `PiPulseTools`, or `PiTextGeneration`
- no `PiAdapterShape`
- no Pi entry in `BUILT_IN_DRIVERS`

### Contracts/settings

- no `PiSettings`
- no `ServerSettings.providers.pi` or patch
- no Pi model defaults/display name
- no runtime discovery request/result/capability schemas
- no optional discovery methods on `ProviderAdapterShape`
- no `input.queue.updated` runtime event

### Client

- no Pi client definition in provider settings metadata
- no Pi chat icon mapping/provider option/order/default
- no runtime provider discovery UI
- no queued steer/follow-up card
- `piAgent` is only a coming-soon label, which conflicts with the older `pi` driver key

### Vendored source

The current checkout has no `.repos/pi`. Add Pi to the repository's vendored reference configuration and sync it when adding/updating the dependency, following the repository rule that installed and vendored dependency versions stay aligned.

## 10. Migration hazards and design decisions

### 10.1 Do not blindly cherry-pick

The older implementation targets an older contract surface and the pre-`0.80.8` Pi SDK. Pi `0.80.8` replaced `AuthStorage`/`ModelRegistry` session construction with async `ModelRuntime`, changed refresh to async, and removed several old registry projections. The current fork also has newer provider maintenance, update checks, runtime modes, model defaults, and client fallback logic. Port behavior into current patterns and Pi `0.82.0` APIs rather than transplanting whole files.

### 10.2 Global `process.env` mutation

The older driver/adapter temporarily mutates `process.env` while creating registries/sessions so per-instance environment variables influence Pi auth/model loading.

This is process-global. Concurrent Pi instance creation can leak credentials or configuration between instances. Pi `0.82.0`'s `ModelRuntime` supports explicit credential/model paths and auth overrides, so use those APIs wherever possible. For ambient provider variables that still require process environment, introduce a reviewed isolation/serialization strategy and focused concurrency tests; do not copy the old mutation unchanged.

### 10.3 Persisted settings compatibility

`ProviderDriverKind` is intentionally open in current `packages/contracts/src/providerInstance.ts`, so explicit `{ driver: "pi" }` instance envelopes can round-trip even when unavailable. But current `ServerSettings.providers` does not include `pi`; legacy `providers.pi` is not represented by the current typed schema.

Decide whether to:

- re-add legacy `providers.pi` and let generic hydration synthesize the default instance, or
- migrate persisted old `providers.pi` to `providerInstances.pi` before normal schema round-trips.

### 10.4 Session file lifecycle

Pi resume depends on external JSONL session files. Tests must cover:

- restart/resume
- missing or moved session file
- changed cwd/worktree
- Pi package upgrade/downgrade
- provider-instance changes
- rollback after resume
- server cleanup/archive behavior versus Pi session retention

### 10.5 Event ordering and fan-out

Test through `ProviderService` and `ProviderRuntimeIngestion`, including:

- text and reasoning streaming
- multiple assistant segments
- cumulative/partial tool output with near-linear byte/CPU growth
- rolling/truncated Pi `0.82` bash snapshots without duplicated output
- large structured partial results without full-object serialization per update
- abort while a tool is active
- retry terminal states
- duplicate `message_end`/`agent_end` handling
- compaction with queued input
- multiple event subscribers

The historical `Queue` to `PubSub` streaming fix shows this is not theoretical.

### 10.6 Security/full-access semantics

The older integration treats Pi as full-access and does not map T3 approval requests. The adapter's `respondToRequest` and `respondToUserInput` intentionally fail in the current old HEAD.

Before shipping, explicitly choose one of:

- preserve Pi-native full-access/tool policy, or
- design a real Pi extension/tool approval bridge.

Do not show approval controls in the UI if the adapter cannot honor them.

### 10.7 Extension UI is not in the integrated old HEAD

Historical branches contain additional work for Pi extension UI (`PiExtensionUiBridge`, runtime panel, custom messages), but those commits are not ancestors of the older fork's current HEAD. Treat them as experimental reference, not current behavior. The integrated HEAD supports Pi extensions/resources through the SDK and discovers extension commands/tools, but does not provide full Pi TUI compatibility.

## 11. Recommended implementation sequence

1. **Pin and vendor Pi 0.8x**
   - Add exact `@earendil-works/pi-coding-agent@0.82.0` to `apps/server` (or update this exact pin to the reviewed current `0.8x` release immediately before implementation).
   - Add/sync `.repos/pi` at the matching source revision.
   - Implement against `ModelRuntime`, not the removed `AuthStorage`/`ModelRegistry` session options.
   - Add a compile/API characterization test covering session creation, model discovery, refresh, and auth state against the pinned package.

2. **Contracts and settings**
   - Add `PiSettings` and its patch.
   - Decide legacy `providers.pi` compatibility versus a persistence migration.
   - Add Pi model defaults/display name.
   - Add runtime discovery contracts and `input.queue.updated` if preserving old parity.

3. **Driver and snapshot**
   - Implement `PiDriver` using current driver/maintenance/update patterns.
   - Implement model/auth/skill/command snapshot status.
   - Resolve the environment-injection design before advertising safe multi-instance support.

4. **Adapter core**
   - Start/resume/stop/interrupt.
   - Text/reasoning/tool event mapping.
   - Implement bounded incremental tool-output projection; do not port the old `startsWith` + whole-JSON recursive diff unchanged.
   - Image inputs and model/thinking switch.
   - Session cursor and rollback.

5. **Pi-specific behavior**
   - steer/follow-up
   - reload
   - compaction and queued-during-compaction input
   - runtime model/skill/command discovery
   - T3-native custom tools

6. **Text generation**
   - Add ephemeral no-tools Pi generation and routing/defaults.

7. **Client**
   - Register `pi` consistently in settings, icons, picker, ordering, and defaults.
   - Port runtime discovery into the current composer architecture.
   - Port queued input UI if mid-turn steering/follow-up is exposed.
   - Remove or rename the conflicting `piAgent` coming-soon entry.

8. **Focused verification**
   - Server tests for every adapter lifecycle/event path.
   - Orchestration ingestion tests for streaming/tool/queue/compaction semantics.
   - Settings migration/hydration tests.
   - Web tests for provider setup, model/thinking selection, commands/skills, queued input, and unavailable-auth state.
   - One integrated web verification pass using the repository's `test-t3-app` workflow after the user-visible implementation is complete.

## Source index

Older fork implementation:

- `apps/server/src/provider/Drivers/PiDriver.ts`
- `apps/server/src/provider/Layers/PiProvider.ts`
- `apps/server/src/provider/Layers/PiAdapter.ts`
- `apps/server/src/provider/Layers/PiPulseTools.ts`
- `apps/server/src/provider/Services/PiAdapter.ts`
- `apps/server/src/textGeneration/PiTextGeneration.ts`
- `apps/server/src/provider/builtInDrivers.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `packages/contracts/src/settings.ts`
- `packages/contracts/src/model.ts`
- `packages/contracts/src/provider.ts`
- `packages/contracts/src/providerRuntime.ts`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/chat/providerDiscoveryUi.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/settings/providerDriverMeta.ts`
- `apps/web/src/components/chat/providerIconUtils.ts`
- `apps/web/src/providerInstances.ts`
- `apps/web/src/session-logic.ts`

Official Pi sources in the older vendored repo:

- `.repos/pi/packages/coding-agent/docs/sdk.md`
- `.repos/pi/packages/coding-agent/docs/sessions.md`
- `.repos/pi/packages/coding-agent/docs/compaction.md`
- `.repos/pi/packages/coding-agent/src/core/sdk.ts`
- `.repos/pi/packages/coding-agent/src/core/agent-session.ts`
- `.repos/pi/packages/coding-agent/src/core/agent-session-services.ts`
- `.repos/pi/packages/coding-agent/src/core/session-manager.ts`
- `.repos/pi/packages/coding-agent/src/core/model-registry.ts`
- `.repos/pi/packages/coding-agent/src/core/auth-storage.ts`
