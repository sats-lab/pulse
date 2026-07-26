import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { ContextWindowSnapshot } from "../../lib/providerRuntimePresentation";
import { formatContextWindowTokens } from "../../lib/providerRuntimePresentation";

export function ContextWindowIndicator(props: { readonly usage: ContextWindowSnapshot }) {
  const percentage = Math.max(0, Math.min(100, props.usage.usedPercentage ?? 0));
  const percentageLabel =
    props.usage.usedPercentage === null
      ? null
      : props.usage.usedPercentage < 10
        ? `${props.usage.usedPercentage.toFixed(1).replace(/\.0$/, "")}%`
        : `${Math.round(props.usage.usedPercentage)}%`;
  const overloaded = percentage > 90;

  return (
    <Pressable
      accessibilityRole="summary"
      accessibilityLabel={
        percentageLabel
          ? `Context window ${percentageLabel} used, ${formatContextWindowTokens(props.usage.usedTokens)} of ${formatContextWindowTokens(props.usage.maxTokens ?? null)} tokens`
          : `Context window ${formatContextWindowTokens(props.usage.usedTokens)} tokens used`
      }
      className="h-11 min-w-16 justify-center rounded-full bg-subtle px-3"
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text className="font-t3-medium text-2xs tabular-nums text-foreground-muted">
          {percentageLabel ?? formatContextWindowTokens(props.usage.usedTokens)}
        </Text>
        <View className="h-1.5 w-7 overflow-hidden rounded-full bg-subtle-strong">
          <View
            className={
              overloaded ? "h-full rounded-full bg-danger" : "h-full rounded-full bg-primary"
            }
            style={{ width: `${percentage}%` }}
          />
        </View>
      </View>
    </Pressable>
  );
}
