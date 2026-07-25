import type {
    OrchestrationThreadActivity,
    ProviderInputQueueMutation,
} from "@t3tools/contracts";
import {
    ArrowUpRightIcon,
    Clock3Icon,
    LoaderCircleIcon,
    MessageCircleMoreIcon,
    XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export interface QueuedInputSnapshot {
    readonly steering: ReadonlyArray<string>;
    readonly followUp: ReadonlyArray<string>;
}

const EMPTY_QUEUE: QueuedInputSnapshot = {
    steering: [],
    followUp: [],
};

function parseQueueMessages(value: unknown): ReadonlyArray<string> {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string");
}

export function deriveLatestQueuedInputSnapshot(
    activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
): QueuedInputSnapshot {
    for (let index = (activities?.length ?? 0) - 1; index >= 0; index -= 1) {
        const activity = activities?.[index];
        if (activity?.kind !== "input.queue.updated") continue;
        const payload = activity.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
            return EMPTY_QUEUE;
        const queue = payload as { steering?: unknown; followUp?: unknown };
        return {
            steering: parseQueueMessages(queue.steering),
            followUp: parseQueueMessages(queue.followUp),
        };
    }
    return EMPTY_QUEUE;
}

export function queuedInputCount(snapshot: QueuedInputSnapshot): number {
    return snapshot.steering.length + snapshot.followUp.length;
}

export function QueueSection(props: {
    readonly mode: "steer" | "followUp";
    readonly messages: ReadonlyArray<string>;
    readonly canMutate: boolean;
    readonly isMutating: boolean;
    readonly onMutate?: (mutation: ProviderInputQueueMutation) => void;
}) {
    if (props.messages.length === 0) return null;

    const isSteering = props.mode === "steer";
    const ModeIcon = isSteering ? ArrowUpRightIcon : Clock3Icon;

    return (
        <section
            aria-label={isSteering ? "Steering messages" : "Follow-up messages"}
        >
            <div className="flex items-center justify-between gap-3 px-3 pb-1.5 pt-3">
                <div className="flex min-w-0 items-center gap-2">
                    <span
                        className={cn(
                            "grid size-5 shrink-0 place-items-center rounded-md",
                            isSteering
                                ? "bg-blue-500/10 text-blue-500 dark:text-blue-400"
                                : "bg-violet-500/10 text-violet-500 dark:text-violet-400",
                        )}
                    >
                        <ModeIcon className="size-3" />
                    </span>
                    <span className="font-medium text-xs text-foreground">
                        {isSteering ? "Steering" : "Follow up"}
                    </span>
                    <span className="text-[11px] tabular-nums text-muted-foreground/55">
                        {props.messages.length}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground/55">
                        {isSteering
                            ? "During this response"
                            : "After this response"}
                    </span>
                    {props.canMutate ? (
                        <button
                            type="button"
                            disabled={props.isMutating}
                            onClick={() =>
                                props.onMutate?.({
                                    type: "clear-mode",
                                    mode: props.mode,
                                })
                            }
                            className="cursor-pointer text-[10px] font-medium text-muted-foreground/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                            aria-label={`Clear ${isSteering ? "steering" : "follow-up"} queue`}
                        >
                            Clear
                        </button>
                    ) : null}
                </div>
            </div>

            <div className="grid gap-1 px-2 pb-1">
                {props.messages.map((message, index) => {
                    const occurrence = props.messages
                        .slice(0, index + 1)
                        .filter((entry) => entry === message).length;
                    return (
                        <div
                            key={`${props.mode}-${message}-${occurrence}`}
                            className="flex items-start gap-2.5 rounded-lg px-2 py-2.5 transition-colors hover:bg-foreground/[0.035]"
                        >
                            <span className="grid size-5 shrink-0 place-items-center self-start rounded-full border border-border/60 bg-background/55 font-mono text-[9px] leading-none tabular-nums text-muted-foreground/55">
                                {index + 1}
                            </span>
                            <p className="min-w-0 flex-1 self-start whitespace-pre-wrap break-words text-pretty text-[12px] leading-5 text-foreground/82">
                                {message}
                            </p>
                            {props.canMutate ? (
                                <button
                                    type="button"
                                    disabled={props.isMutating}
                                    onClick={() =>
                                        props.onMutate?.({
                                            type: "remove",
                                            mode: props.mode,
                                            index,
                                            expectedText: message,
                                        })
                                    }
                                    className="grid size-6 shrink-0 cursor-pointer place-items-center self-start rounded-md text-muted-foreground/55 hover:bg-muted/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                                    aria-label={`Remove queued ${isSteering ? "steering" : "follow-up"} message ${index + 1}`}
                                >
                                    <XIcon className="size-3.5" />
                                </button>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

export function QueuedMessagesPopover(props: {
    readonly snapshot: QueuedInputSnapshot;
    readonly providerDisplayName?: string | null;
    readonly isRunning: boolean;
    readonly canMutate?: boolean;
    readonly isMutating?: boolean;
    readonly onMutate?: (mutation: ProviderInputQueueMutation) => void;
    readonly open?: boolean;
    readonly onOpenChange?: (open: boolean) => void;
}) {
    const count = queuedInputCount(props.snapshot);
    if (count === 0) return null;

    const providerDisplayName = props.providerDisplayName?.trim() || "Pi";

    return (
        <Popover
            {...(props.open !== undefined ? { open: props.open } : {})}
            {...(props.onOpenChange
                ? { onOpenChange: props.onOpenChange }
                : {})}
        >
            <PopoverTrigger
                render={
                    <button
                        type="button"
                        className={cn(
                            "inline-flex size-5 cursor-pointer items-center justify-center rounded-full border font-medium text-[11px] tabular-nums outline-none transition-all",
                            "border-blue-500/25 bg-blue-500/8 text-blue-600 hover:border-blue-500/40 hover:bg-blue-500/12 dark:text-blue-300",
                            "focus-visible:ring-2 focus-visible:ring-blue-500/35 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                            "data-[pressed]:border-blue-500/45 data-[pressed]:bg-blue-500/15",
                        )}
                        aria-label={`View ${count} queued ${count === 1 ? "message" : "messages"}`}
                        data-chat-composer-queued-messages="true"
                    />
                }
            >
                {count > 99 ? "99+" : count}
            </PopoverTrigger>
            <PopoverPopup
                side="top"
                align="end"
                sideOffset={10}
                className="w-[min(23rem,calc(100vw-1.5rem))] border-0! bg-transparent p-0 shadow-none before:hidden"
                viewportClassName="overflow-hidden rounded-xl border border-border/55 bg-popover/95 p-0 shadow-xl shadow-black/10 backdrop-blur-xl dark:bg-popover/92 dark:shadow-black/35"
            >
                <div className="flex items-start justify-between gap-3 border-b border-border/45 px-3.5 py-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <MessageCircleMoreIcon className="size-3.5 text-blue-500 dark:text-blue-400" />
                            <h2 className="font-semibold text-[13px] text-foreground">
                                Queued for {providerDisplayName}
                            </h2>
                            <span className="rounded-full bg-muted/70 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                                {count}
                            </span>
                        </div>
                        <p className="mt-1 text-[11px] leading-4 text-muted-foreground/65">
                            {providerDisplayName} will consume these
                            automatically as it works.
                        </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        {props.canMutate ? (
                            <button
                                type="button"
                                disabled={props.isMutating}
                                onClick={() =>
                                    props.onMutate?.({ type: "clear-all" })
                                }
                                className="cursor-pointer text-[10px] font-medium text-muted-foreground/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                                aria-label="Clear all queued messages"
                            >
                                Clear all
                            </button>
                        ) : null}
                        {props.isRunning ? (
                            <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/8 px-2 py-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                <LoaderCircleIcon className="size-3 animate-spin motion-reduce:animate-none" />
                                Working
                            </div>
                        ) : null}
                    </div>
                </div>

                <div className="max-h-[22rem] overflow-y-auto overscroll-contain pb-2">
                    <QueueSection
                        mode="steer"
                        messages={props.snapshot.steering}
                        canMutate={props.canMutate ?? false}
                        isMutating={props.isMutating ?? false}
                        {...(props.onMutate
                            ? { onMutate: props.onMutate }
                            : {})}
                    />
                    {props.snapshot.steering.length > 0 &&
                    props.snapshot.followUp.length > 0 ? (
                        <div className="mx-3 mt-2 h-px bg-border/45" />
                    ) : null}
                    <QueueSection
                        mode="followUp"
                        messages={props.snapshot.followUp}
                        canMutate={props.canMutate ?? false}
                        isMutating={props.isMutating ?? false}
                        {...(props.onMutate
                            ? { onMutate: props.onMutate }
                            : {})}
                    />
                </div>

                <div className="border-t border-border/45 bg-muted/18 px-3.5 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground/65">
                        <span className="inline-flex items-center gap-1.5">
                            <kbd className="rounded border border-border/65 bg-background/70 px-1.5 py-0.5 font-sans text-[9px] text-foreground/70 shadow-xs">
                                Enter
                            </kbd>
                            steer
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                            <kbd className="rounded border border-border/65 bg-background/70 px-1.5 py-0.5 font-sans text-[9px] text-foreground/70 shadow-xs">
                                Alt / ⌥ Enter
                            </kbd>
                            follow up
                        </span>
                    </div>
                </div>
            </PopoverPopup>
        </Popover>
    );
}
