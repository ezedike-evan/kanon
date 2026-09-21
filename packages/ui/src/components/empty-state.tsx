import { Text, View } from 'react-native';
import { cx } from '../lib/cx';
import { Icon, type Icon as IconName } from './icons';
import { GhostButton, PrimaryButton } from './ui';

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  /** One or two plain sentences: what this list is for and how it fills. */
  body?: string | undefined;
  action?: { label: string; href?: string; onPress?: () => void; primary?: boolean } | undefined;
  className?: string | undefined;
}

/**
 * A composed "nothing here yet". Says what the screen is for and offers the
 * next step, so an empty list reads as a start, not a fault. Never apologetic:
 * "No blocked trades" is a good day for a rule engine.
 */
export function EmptyState({ icon, title, body, action, className }: EmptyStateProps) {
  const Button = action?.primary ? PrimaryButton : GhostButton;
  return (
    <View className={cx('items-center gap-3 px-6 py-10', className)}>
      <View className="size-12 items-center justify-center rounded-sm border border-hairline bg-raised">
        <Icon name={icon} size={22} color="ash" />
      </View>
      <View className="items-center gap-1.5">
        <Text className="font-mono-medium text-13 uppercase tracking-w10 text-bone">{title}</Text>
        {body ? (
          <Text className="max-w-72 text-center font-sans text-13 text-ash">{body}</Text>
        ) : null}
      </View>
      {action ? (
        <View className="mt-1 w-full max-w-64">
          <Button
            {...(action.href ? { href: action.href } : null)}
            {...(action.onPress ? { onPress: action.onPress } : null)}
          >
            {action.label}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
