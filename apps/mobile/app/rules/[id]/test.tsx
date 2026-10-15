import { useLocalSearchParams } from 'expo-router';
import { BacktestScreen } from '@kanon/ui';

export default function RuleTestRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <BacktestScreen ruleId={id ?? ''} />;
}
