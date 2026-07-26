import { ChevronDownIcon, ChevronUpIcon, LinkIcon, PlusIcon, ShieldCheckIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";

const prototypeEnvironments = [
  {
    id: "local",
    label: "This environment",
    detail: "Desktop backend · 127.0.0.1",
    connection: "connected" as const,
    canManageAccess: true,
    local: true,
  },
  {
    id: "studio",
    label: "Studio workstation",
    detail: "Remote link · studio.tailnet.ts.net",
    connection: "connected" as const,
    canManageAccess: true,
    local: false,
  },
  {
    id: "staging",
    label: "Staging runner",
    detail: "Remote link · staging.example.net",
    connection: "disconnected" as const,
    canManageAccess: false,
    local: false,
  },
] as const;

type PrototypeEnvironmentId = (typeof prototypeEnvironments)[number]["id"];
type PrototypeVariant = "picker" | "inline" | "access-list";

type PrototypePairingLink = {
  readonly id: string;
  readonly label: string;
  readonly expires: string;
  readonly scopes: string;
};

type PrototypeClient = {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly scopes: string;
  readonly current?: boolean;
  readonly connected: boolean;
};

type PrototypeAccessState = Record<
  PrototypeEnvironmentId,
  {
    readonly links: ReadonlyArray<PrototypePairingLink>;
    readonly clients: ReadonlyArray<PrototypeClient>;
  }
>;

const initialAccessState: PrototypeAccessState = {
  local: {
    links: [
      {
        id: "local-link-ipad",
        label: "Living room iPad",
        expires: "Expires in 4m 12s",
        scopes: "4 scopes",
      },
    ],
    clients: [
      {
        id: "local-current",
        label: "Chan’s desktop",
        detail: "Desktop · Linux · 127.0.0.1",
        scopes: "8 scopes",
        current: true,
        connected: true,
      },
      {
        id: "local-phone",
        label: "Chan’s phone",
        detail: "Phone · iOS · 100.92.18.4",
        scopes: "4 scopes",
        connected: true,
      },
    ],
  },
  studio: {
    links: [
      {
        id: "studio-link-laptop",
        label: "Office laptop",
        expires: "Expires in 3m 38s",
        scopes: "8 scopes",
      },
    ],
    clients: [
      {
        id: "studio-current",
        label: "Chan’s desktop",
        detail: "Desktop · Linux · 100.84.12.7",
        scopes: "8 scopes",
        current: true,
        connected: true,
      },
      {
        id: "studio-macbook",
        label: "Travel MacBook",
        detail: "Desktop · macOS · last connected 8m ago",
        scopes: "8 scopes",
        connected: false,
      },
    ],
  },
  staging: {
    links: [],
    clients: [],
  },
};

function PrototypeChrome({
  variant,
  onVariantChange,
}: {
  readonly variant: PrototypeVariant;
  readonly onVariantChange: (variant: PrototypeVariant) => void;
}) {
  const variants: ReadonlyArray<{
    readonly id: PrototypeVariant;
    readonly label: string;
    readonly description: string;
  }> = [
    {
      id: "picker",
      label: "A · Section picker",
      description: "Keep one Authorized clients section and choose its environment in the header.",
    },
    {
      id: "inline",
      label: "B · Inline rows",
      description: "Open access management directly under a remote-environment row.",
    },
    {
      id: "access-list",
      label: "C · Access list",
      description: "Add a compact environment access section using the existing row treatment.",
    },
  ];

  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-muted/15 px-3 py-3 sm:px-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge variant="warning">Prototype</Badge>
            <span className="text-xs text-muted-foreground">Connections page extensions</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            All three variants preserve the current settings sections, rows, spacing, and actions.
          </p>
        </div>
        <Button size="xs" variant="outline" render={<a href="/settings/connections" />}>
          Open current page
        </Button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {variants.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={variant === option.id}
            onClick={() => onVariantChange(option.id)}
            className={cn(
              "rounded-lg border px-3 py-2.5 text-left transition-colors",
              variant === option.id
                ? "border-primary/45 bg-primary/5"
                : "border-border/60 bg-background/40 hover:bg-muted/35",
            )}
          >
            <span className="block text-xs font-medium text-foreground">{option.label}</span>
            <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
              {option.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EnvironmentStatus({
  environmentId,
  showPermission = true,
}: {
  readonly environmentId: PrototypeEnvironmentId;
  readonly showPermission?: boolean;
}) {
  const environment = prototypeEnvironments.find((candidate) => candidate.id === environmentId)!;
  const connected = environment.connection === "connected";

  return (
    <div className="flex min-w-0 items-center gap-2">
      <ConnectionStatusDot
        tooltipText={connected ? "Connected" : "Saved, currently disconnected"}
        dotClassName={connected ? "bg-success" : "bg-muted-foreground/35"}
        pingClassName={connected ? "bg-success/60 duration-2000" : null}
      />
      <span className="min-w-0 truncate text-xs text-muted-foreground">{environment.detail}</span>
      {showPermission ? (
        environment.canManageAccess ? (
          <Badge variant="success" size="sm">
            Manage access
          </Badge>
        ) : (
          <Badge variant="secondary" size="sm">
            Standard access
          </Badge>
        )
      ) : null}
    </div>
  );
}

function AccessRows({
  environmentId,
  accessState,
  onRevokeLink,
  onRevokeClient,
}: {
  readonly environmentId: PrototypeEnvironmentId;
  readonly accessState: PrototypeAccessState;
  readonly onRevokeLink: (environmentId: PrototypeEnvironmentId, linkId: string) => void;
  readonly onRevokeClient: (environmentId: PrototypeEnvironmentId, clientId: string) => void;
}) {
  const environment = prototypeEnvironments.find((candidate) => candidate.id === environmentId)!;
  const access = accessState[environmentId];

  if (!environment.canManageAccess) {
    return (
      <SettingsRow
        title="Administrative access required"
        description="This environment is configured on this client, but the saved session does not include access:read and access:write. Pair it again with an administrative link to manage its clients."
        status="Machine-local controls remain available only on the device that owns the backend."
      />
    );
  }

  if (access.links.length === 0 && access.clients.length === 0) {
    return (
      <div className={ITEM_ROW_CLASSNAME}>
        <p className="text-xs text-muted-foreground/60">No pairing links or client sessions.</p>
      </div>
    );
  }

  return (
    <>
      {access.links.map((link) => (
        <div key={link.id} className={ITEM_ROW_CLASSNAME}>
          <div className={ITEM_ROW_INNER_CLASSNAME}>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex min-h-5 items-center gap-1.5">
                <ConnectionStatusDot
                  tooltipText="Active pairing link"
                  dotClassName="bg-amber-400"
                />
                <h3 className="text-sm font-medium text-foreground">{link.label}</h3>
                <LinkIcon className="size-3 text-muted-foreground/50" />
              </div>
              <p className="text-xs text-muted-foreground">
                {link.expires}
                <span aria-hidden> · </span>
                <span className="underline decoration-border underline-offset-2">
                  {link.scopes}
                </span>
              </p>
            </div>
            <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
              <Dialog>
                <DialogTrigger render={<Button size="xs" variant="outline" />}>
                  Show link
                </DialogTrigger>
                <DialogPopup className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Pairing link</DialogTitle>
                    <DialogDescription>
                      Open or manually copy this full pairing URL on the device you want to connect.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogPanel className="space-y-4">
                    <Textarea
                      readOnly
                      value={`https://${environmentId}.example.net/pair#token=PROTOTYPE-${link.id}`}
                      rows={4}
                      className="text-xs leading-relaxed"
                      onFocus={(event) => event.currentTarget.select()}
                      onClick={(event) => event.currentTarget.select()}
                    />
                    <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
                      <QRCodeSvg
                        value={`https://${environmentId}.example.net/pair#token=PROTOTYPE-${link.id}`}
                        size={132}
                        level="M"
                        marginSize={2}
                        title="Pairing link — scan to open on another device"
                      />
                    </div>
                  </DialogPanel>
                  <DialogFooter variant="bare">
                    <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
                  </DialogFooter>
                </DialogPopup>
              </Dialog>
              <Button
                size="xs"
                variant="destructive-outline"
                onClick={() => onRevokeLink(environmentId, link.id)}
              >
                Revoke
              </Button>
            </div>
          </div>
        </div>
      ))}
      {access.clients.map((client) => (
        <div key={client.id} className={ITEM_ROW_CLASSNAME}>
          <div className={ITEM_ROW_INNER_CLASSNAME}>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex min-h-5 items-center gap-1.5">
                <ConnectionStatusDot
                  tooltipText={client.connected ? "Connected" : "Not currently connected"}
                  dotClassName={client.connected ? "bg-success" : "bg-muted-foreground/30"}
                  pingClassName={client.connected ? "bg-success/60 duration-2000" : null}
                />
                <h3 className="text-sm font-medium text-foreground">{client.label}</h3>
                {client.current ? (
                  <span className="rounded-md border border-border/50 bg-muted/50 px-1 py-0.5 text-[10px] text-muted-foreground/80">
                    This device
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {client.detail}
                <span aria-hidden> · </span>
                <span className="underline decoration-border underline-offset-2">
                  {client.scopes}
                </span>
              </p>
            </div>
            <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
              {!client.current ? (
                <Button
                  size="xs"
                  variant="destructive-outline"
                  onClick={() => onRevokeClient(environmentId, client.id)}
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

function CreateLinkDialog({
  environmentId,
  onCreate,
}: {
  readonly environmentId: PrototypeEnvironmentId;
  readonly onCreate: (
    environmentId: PrototypeEnvironmentId,
    input: { readonly label: string; readonly administrative: boolean },
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [administrative, setAdministrative] = useState(false);
  const environment = prototypeEnvironments.find((candidate) => candidate.id === environmentId)!;

  const create = () => {
    onCreate(environmentId, { label, administrative });
    setLabel("");
    setAdministrative(false);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="xs" variant="default" disabled={!environment.canManageAccess}>
            <PlusIcon className="size-3" /> Create link
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create pairing link</DialogTitle>
          <DialogDescription>
            Generate a one-time link for {environment.label}. It cannot grant permissions your
            current session does not hold.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Client label (optional)
            </span>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Living room iPad"
              autoFocus
            />
          </label>
          <SettingsRow
            className="border border-border/60 bg-muted/15"
            title="Manage access"
            description="Allow this client to create links and revoke clients on this environment."
            control={
              <Switch
                checked={administrative}
                onCheckedChange={setAdministrative}
                aria-label="Grant access management"
              />
            }
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={create}>Create link</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function AccessHeaderActions({
  environmentId,
  accessState,
  onCreateLink,
  onRevokeOthers,
}: {
  readonly environmentId: PrototypeEnvironmentId;
  readonly accessState: PrototypeAccessState;
  readonly onCreateLink: (
    environmentId: PrototypeEnvironmentId,
    input: { readonly label: string; readonly administrative: boolean },
  ) => void;
  readonly onRevokeOthers: (environmentId: PrototypeEnvironmentId) => void;
}) {
  const environment = prototypeEnvironments.find((candidate) => candidate.id === environmentId)!;
  const hasOtherClients = accessState[environmentId].clients.some((client) => !client.current);

  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={!environment.canManageAccess || !hasOtherClients}
        onClick={() => onRevokeOthers(environmentId)}
      >
        Revoke others
      </Button>
      <CreateLinkDialog environmentId={environmentId} onCreate={onCreateLink} />
    </div>
  );
}

function CurrentEnvironmentSection() {
  return (
    <SettingsSection title="This environment">
      <SettingsRow
        title="Network access"
        description="Reachable at http://192.168.1.24:3773 · +2"
        control={<Switch checked aria-label="Enable network access" />}
      />
      <SettingsRow
        title="Tailscale HTTPS"
        description="https://desktop.tailnet.ts.net"
        control={<Switch checked aria-label="Enable Tailscale HTTPS" />}
      />
      <SettingsRow
        title="WSL backend"
        description="Run a second backend inside a WSL distro alongside the Windows one."
        control={
          <Select value="Ubuntu">
            <SelectTrigger className="w-full sm:w-56" aria-label="WSL backend">
              <SelectValue>Ubuntu</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="Off">Off</SelectItem>
              <SelectItem value="Ubuntu">Ubuntu</SelectItem>
              <SelectItem value="Debian">Debian</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="T3 Connect"
        description="This environment is available to your other devices through T3 Connect."
        control={<Switch checked aria-label="Enable T3 Connect" />}
      />
    </SettingsSection>
  );
}

function RemoteEnvironmentRow({
  environmentId,
  extraAction,
  expanded,
  children,
}: {
  readonly environmentId: Exclude<PrototypeEnvironmentId, "local">;
  readonly extraAction?: React.ReactNode;
  readonly expanded?: boolean;
  readonly children?: React.ReactNode;
}) {
  const environment = prototypeEnvironments.find((candidate) => candidate.id === environmentId)!;
  const connected = environment.connection === "connected";

  return (
    <div className={cn(expanded && "rounded-xl bg-muted/20")}>
      <div className={ITEM_ROW_CLASSNAME}>
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-h-5 items-center gap-1.5">
              <ConnectionStatusDot
                tooltipText={connected ? "Connected" : "Saved, currently disconnected"}
                dotClassName={connected ? "bg-success" : "bg-muted-foreground/40"}
                pingClassName={connected ? "bg-success/60 duration-2000" : null}
              />
              <h3 className="text-sm font-medium text-foreground">{environment.label}</h3>
            </div>
            <p className="text-xs text-muted-foreground">{environment.detail}</p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {extraAction}
            <Button size="xs" variant="outline">
              {connected ? "Disconnect" : "Connect"}
            </Button>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

function RemoteEnvironmentsSection({
  renderExtraAction,
  renderExpanded,
}: {
  readonly renderExtraAction?: (
    environmentId: Exclude<PrototypeEnvironmentId, "local">,
  ) => React.ReactNode;
  readonly renderExpanded?: (
    environmentId: Exclude<PrototypeEnvironmentId, "local">,
  ) => React.ReactNode;
}) {
  return (
    <SettingsSection
      title="Remote environments"
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          className="h-5 gap-1 rounded-sm px-1 text-[11px] font-normal text-muted-foreground/60"
        >
          <PlusIcon className="size-3" /> Add environment
        </Button>
      }
    >
      {(["studio", "staging"] as const).map((environmentId) => {
        const expandedContent = renderExpanded?.(environmentId);
        return (
          <RemoteEnvironmentRow
            key={environmentId}
            environmentId={environmentId}
            extraAction={renderExtraAction?.(environmentId)}
            expanded={expandedContent !== undefined && expandedContent !== null}
          >
            {expandedContent}
          </RemoteEnvironmentRow>
        );
      })}
    </SettingsSection>
  );
}

function PickerVariant({
  selectedEnvironmentId,
  onSelectedEnvironmentChange,
  accessState,
  onCreateLink,
  onRevokeLink,
  onRevokeClient,
  onRevokeOthers,
}: {
  readonly selectedEnvironmentId: PrototypeEnvironmentId;
  readonly onSelectedEnvironmentChange: (environmentId: PrototypeEnvironmentId) => void;
  readonly accessState: PrototypeAccessState;
  readonly onCreateLink: (
    environmentId: PrototypeEnvironmentId,
    input: { readonly label: string; readonly administrative: boolean },
  ) => void;
  readonly onRevokeLink: (environmentId: PrototypeEnvironmentId, linkId: string) => void;
  readonly onRevokeClient: (environmentId: PrototypeEnvironmentId, clientId: string) => void;
  readonly onRevokeOthers: (environmentId: PrototypeEnvironmentId) => void;
}) {
  const selectedEnvironment = prototypeEnvironments.find(
    (environment) => environment.id === selectedEnvironmentId,
  )!;

  return (
    <>
      <CurrentEnvironmentSection />
      <SettingsSection
        title="Authorized clients"
        headerAction={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Select
              value={selectedEnvironmentId}
              onValueChange={(value) => {
                if (typeof value === "string") {
                  onSelectedEnvironmentChange(value as PrototypeEnvironmentId);
                }
              }}
            >
              <SelectTrigger
                size="xs"
                className="w-44"
                aria-label="Environment whose authorized clients are shown"
              >
                <SelectValue>{selectedEnvironment.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {prototypeEnvironments.map((environment) => (
                  <SelectItem key={environment.id} value={environment.id}>
                    {environment.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <AccessHeaderActions
              environmentId={selectedEnvironmentId}
              accessState={accessState}
              onCreateLink={onCreateLink}
              onRevokeOthers={onRevokeOthers}
            />
          </div>
        }
      >
        <ScrollArea scrollFade className="max-h-[22.5rem]">
          <AccessRows
            environmentId={selectedEnvironmentId}
            accessState={accessState}
            onRevokeLink={onRevokeLink}
            onRevokeClient={onRevokeClient}
          />
        </ScrollArea>
      </SettingsSection>
      <RemoteEnvironmentsSection />
    </>
  );
}

function InlineVariant({
  expandedEnvironmentId,
  onExpandedEnvironmentChange,
  accessState,
  onCreateLink,
  onRevokeLink,
  onRevokeClient,
  onRevokeOthers,
}: {
  readonly expandedEnvironmentId: Exclude<PrototypeEnvironmentId, "local"> | null;
  readonly onExpandedEnvironmentChange: (
    environmentId: Exclude<PrototypeEnvironmentId, "local"> | null,
  ) => void;
  readonly accessState: PrototypeAccessState;
  readonly onCreateLink: (
    environmentId: PrototypeEnvironmentId,
    input: { readonly label: string; readonly administrative: boolean },
  ) => void;
  readonly onRevokeLink: (environmentId: PrototypeEnvironmentId, linkId: string) => void;
  readonly onRevokeClient: (environmentId: PrototypeEnvironmentId, clientId: string) => void;
  readonly onRevokeOthers: (environmentId: PrototypeEnvironmentId) => void;
}) {
  return (
    <>
      <CurrentEnvironmentSection />
      <SettingsSection
        title="Authorized clients"
        headerAction={
          <AccessHeaderActions
            environmentId="local"
            accessState={accessState}
            onCreateLink={onCreateLink}
            onRevokeOthers={onRevokeOthers}
          />
        }
      >
        <ScrollArea scrollFade className="max-h-[22.5rem]">
          <AccessRows
            environmentId="local"
            accessState={accessState}
            onRevokeLink={onRevokeLink}
            onRevokeClient={onRevokeClient}
          />
        </ScrollArea>
      </SettingsSection>
      <RemoteEnvironmentsSection
        renderExtraAction={(environmentId) => {
          const environment = prototypeEnvironments.find(
            (candidate) => candidate.id === environmentId,
          )!;
          const expanded = expandedEnvironmentId === environmentId;
          return (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onExpandedEnvironmentChange(expanded ? null : environmentId)}
            >
              {environment.canManageAccess ? "Manage access" : "Access details"}
              {expanded ? (
                <ChevronUpIcon className="size-3" />
              ) : (
                <ChevronDownIcon className="size-3" />
              )}
            </Button>
          );
        }}
        renderExpanded={(environmentId) =>
          expandedEnvironmentId === environmentId ? (
            <div className="border-t border-border/50 px-2 pb-2 sm:px-3">
              <div className="flex items-center justify-between gap-3 px-3 py-2.5 sm:px-4">
                <EnvironmentStatus environmentId={environmentId} />
                <AccessHeaderActions
                  environmentId={environmentId}
                  accessState={accessState}
                  onCreateLink={onCreateLink}
                  onRevokeOthers={onRevokeOthers}
                />
              </div>
              <AccessRows
                environmentId={environmentId}
                accessState={accessState}
                onRevokeLink={onRevokeLink}
                onRevokeClient={onRevokeClient}
              />
            </div>
          ) : null
        }
      />
    </>
  );
}

function AccessListVariant({
  expandedEnvironmentId,
  onExpandedEnvironmentChange,
  accessState,
  onCreateLink,
  onRevokeLink,
  onRevokeClient,
  onRevokeOthers,
}: {
  readonly expandedEnvironmentId: PrototypeEnvironmentId | null;
  readonly onExpandedEnvironmentChange: (environmentId: PrototypeEnvironmentId | null) => void;
  readonly accessState: PrototypeAccessState;
  readonly onCreateLink: (
    environmentId: PrototypeEnvironmentId,
    input: { readonly label: string; readonly administrative: boolean },
  ) => void;
  readonly onRevokeLink: (environmentId: PrototypeEnvironmentId, linkId: string) => void;
  readonly onRevokeClient: (environmentId: PrototypeEnvironmentId, clientId: string) => void;
  readonly onRevokeOthers: (environmentId: PrototypeEnvironmentId) => void;
}) {
  return (
    <>
      <CurrentEnvironmentSection />
      <SettingsSection title="Environment access">
        {prototypeEnvironments.map((environment) => {
          const expanded = expandedEnvironmentId === environment.id;
          const access = accessState[environment.id];
          const count = access.links.length + access.clients.length;
          return (
            <div key={environment.id} className={cn(expanded && "rounded-xl bg-muted/20")}>
              <div className={ITEM_ROW_CLASSNAME}>
                <div className={ITEM_ROW_INNER_CLASSNAME}>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-h-5 items-center gap-1.5">
                      <ConnectionStatusDot
                        tooltipText={
                          environment.connection === "connected"
                            ? "Connected"
                            : "Saved, currently disconnected"
                        }
                        dotClassName={
                          environment.connection === "connected"
                            ? "bg-success"
                            : "bg-muted-foreground/35"
                        }
                        pingClassName={
                          environment.connection === "connected"
                            ? "bg-success/60 duration-2000"
                            : null
                        }
                      />
                      <h3 className="text-sm font-medium text-foreground">{environment.label}</h3>
                      {environment.canManageAccess ? (
                        <ShieldCheckIcon className="size-3 text-success-foreground" />
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {environment.detail}
                      <span aria-hidden> · </span>
                      {environment.canManageAccess
                        ? `${count} ${count === 1 ? "credential" : "credentials"}`
                        : "Administrative access required"}
                    </p>
                  </div>
                  <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onExpandedEnvironmentChange(expanded ? null : environment.id)}
                    >
                      {expanded ? "Close" : "Manage"}
                      {expanded ? (
                        <ChevronUpIcon className="size-3" />
                      ) : (
                        <ChevronDownIcon className="size-3" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
              {expanded ? (
                <div className="border-t border-border/50 px-2 pb-2 sm:px-3">
                  <div className="flex items-center justify-end gap-2 px-3 py-2.5 sm:px-4">
                    <AccessHeaderActions
                      environmentId={environment.id}
                      accessState={accessState}
                      onCreateLink={onCreateLink}
                      onRevokeOthers={onRevokeOthers}
                    />
                  </div>
                  <AccessRows
                    environmentId={environment.id}
                    accessState={accessState}
                    onRevokeLink={onRevokeLink}
                    onRevokeClient={onRevokeClient}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </SettingsSection>
      <RemoteEnvironmentsSection />
    </>
  );
}

export function RemoteAccessManagementPrototype() {
  const [variant, setVariant] = useState<PrototypeVariant>("picker");
  const [selectedEnvironmentId, setSelectedEnvironmentId] =
    useState<PrototypeEnvironmentId>("studio");
  const [inlineExpandedEnvironmentId, setInlineExpandedEnvironmentId] = useState<Exclude<
    PrototypeEnvironmentId,
    "local"
  > | null>("studio");
  const [listExpandedEnvironmentId, setListExpandedEnvironmentId] =
    useState<PrototypeEnvironmentId | null>("studio");
  const [accessState, setAccessState] = useState<PrototypeAccessState>(initialAccessState);

  const createLink = (
    environmentId: PrototypeEnvironmentId,
    input: { readonly label: string; readonly administrative: boolean },
  ) => {
    setAccessState((current) => ({
      ...current,
      [environmentId]: {
        ...current[environmentId],
        links: [
          {
            id: `prototype-link-${environmentId}-${Date.now()}`,
            label: input.label.trim() || "New paired device",
            expires: "Expires in 5m",
            scopes: input.administrative ? "8 scopes" : "4 scopes",
          },
          ...current[environmentId].links,
        ],
      },
    }));
  };

  const revokeLink = (environmentId: PrototypeEnvironmentId, linkId: string) => {
    setAccessState((current) => ({
      ...current,
      [environmentId]: {
        ...current[environmentId],
        links: current[environmentId].links.filter((link) => link.id !== linkId),
      },
    }));
  };

  const revokeClient = (environmentId: PrototypeEnvironmentId, clientId: string) => {
    setAccessState((current) => ({
      ...current,
      [environmentId]: {
        ...current[environmentId],
        clients: current[environmentId].clients.filter((client) => client.id !== clientId),
      },
    }));
  };

  const revokeOthers = (environmentId: PrototypeEnvironmentId) => {
    setAccessState((current) => ({
      ...current,
      [environmentId]: {
        ...current[environmentId],
        clients: current[environmentId].clients.filter((client) => client.current),
      },
    }));
  };

  const sharedAccessProps = useMemo(
    () => ({
      accessState,
      onCreateLink: createLink,
      onRevokeLink: revokeLink,
      onRevokeClient: revokeClient,
      onRevokeOthers: revokeOthers,
    }),
    [accessState],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header className="px-3 py-2 sm:px-5">
          <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
            <span className="text-sm font-medium text-foreground">Settings</span>
          </div>
        </header>
        <SettingsPageContainer>
          <PrototypeChrome variant={variant} onVariantChange={setVariant} />
          {variant === "picker" ? (
            <PickerVariant
              {...sharedAccessProps}
              selectedEnvironmentId={selectedEnvironmentId}
              onSelectedEnvironmentChange={setSelectedEnvironmentId}
            />
          ) : variant === "inline" ? (
            <InlineVariant
              {...sharedAccessProps}
              expandedEnvironmentId={inlineExpandedEnvironmentId}
              onExpandedEnvironmentChange={setInlineExpandedEnvironmentId}
            />
          ) : (
            <AccessListVariant
              {...sharedAccessProps}
              expandedEnvironmentId={listExpandedEnvironmentId}
              onExpandedEnvironmentChange={setListExpandedEnvironmentId}
            />
          )}
        </SettingsPageContainer>
      </div>
    </SidebarInset>
  );
}
