import type { ProviderInputQueueMode, ProviderInputQueueMutation } from "@t3tools/contracts";
import { Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import type { ProviderInputQueueSnapshot } from "../../lib/providerRuntimePresentation";
import { useThemeColor } from "../../lib/useThemeColor";

function QueueSection(props: {
  readonly mode: ProviderInputQueueMode;
  readonly messages: ReadonlyArray<string>;
  readonly isMutating: boolean;
  readonly onMutate: (mutation: ProviderInputQueueMutation) => void;
}) {
  if (props.messages.length === 0) return null;
  const steering = props.mode === "steer";

  return (
    <View className="gap-2 px-5 py-4">
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <SymbolView name={steering ? "arrow.up.right" : "clock"} size={15} type="monochrome" />
          <Text className="font-t3-bold text-sm">{steering ? "Steering" : "Follow up"}</Text>
          <Text className="text-xs tabular-nums text-foreground-muted">
            {props.messages.length}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Clear ${steering ? "steering" : "follow-up"} queue`}
          disabled={props.isMutating}
          onPress={() => props.onMutate({ type: "clear-mode", mode: props.mode })}
        >
          <Text className="font-t3-medium text-xs text-foreground-muted">Clear</Text>
        </Pressable>
      </View>
      <Text className="text-xs text-foreground-muted">
        {steering ? "Consumed during this response" : "Consumed after this response"}
      </Text>
      {props.messages.map((message, index) => {
        const occurrence = props.messages
          .slice(0, index + 1)
          .filter((entry) => entry === message).length;
        return (
          <View
            key={`${props.mode}-${message}-${occurrence}`}
            className="min-h-12 flex-row items-center gap-3 rounded-2xl bg-subtle px-3 py-3"
          >
            <View className="size-6 items-center justify-center rounded-full bg-subtle-strong">
              <Text className="text-2xs tabular-nums text-foreground-muted">{index + 1}</Text>
            </View>
            <Text className="min-w-0 flex-1 text-sm leading-5">{message}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove queued ${steering ? "steering" : "follow-up"} message ${index + 1}`}
              disabled={props.isMutating}
              hitSlop={8}
              className="size-8 shrink-0 items-center justify-center rounded-full"
              onPress={() =>
                props.onMutate({
                  type: "remove",
                  mode: props.mode,
                  index,
                  expectedText: message,
                })
              }
            >
              <SymbolView name="xmark" size={15} type="monochrome" />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

export function ProviderQueueSheet(props: {
  readonly visible: boolean;
  readonly snapshot: ProviderInputQueueSnapshot;
  readonly providerDisplayName: string;
  readonly isMutating: boolean;
  readonly onClose: () => void;
  readonly onMutate: (mutation: ProviderInputQueueMutation) => void;
}) {
  const backdropPressed = useThemeColor("--color-subtle");

  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={props.onClose}
    >
      <View className="flex-1 justify-end bg-backdrop">
        <Pressable
          accessibilityLabel="Close queued messages"
          className="flex-1"
          onPress={props.onClose}
          android_ripple={{ color: backdropPressed }}
        />
        <View className="max-h-[78%] overflow-hidden rounded-t-[28px] bg-card pb-6">
          <View className="items-center py-2">
            <View className="h-1 w-10 rounded-full bg-subtle-strong" />
          </View>
          <View className="flex-row items-start justify-between gap-3 border-b border-border px-5 pb-4 pt-2">
            <View className="min-w-0 flex-1">
              <Text className="font-t3-bold text-lg">Queued for {props.providerDisplayName}</Text>
              <Text className="mt-1 text-xs leading-4 text-foreground-muted">
                {props.providerDisplayName} consumes these automatically as it works.
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear all queued messages"
              disabled={props.isMutating}
              onPress={() => props.onMutate({ type: "clear-all" })}
            >
              <Text className="font-t3-medium text-xs text-foreground-muted">Clear all</Text>
            </Pressable>
          </View>
          <ScrollView>
            <QueueSection
              mode="steer"
              messages={props.snapshot.steering}
              isMutating={props.isMutating}
              onMutate={props.onMutate}
            />
            <QueueSection
              mode="followUp"
              messages={props.snapshot.followUp}
              isMutating={props.isMutating}
              onMutate={props.onMutate}
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
