import { useLocalSearchParams } from 'expo-router';
import { TradeDetailScreen } from '@kanon/ui';

export default function TradeDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TradeDetailScreen id={id ?? ''} />;
}
