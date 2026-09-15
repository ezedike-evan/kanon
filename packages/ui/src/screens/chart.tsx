import { Text, View } from 'react-native';
import { Body, BrandBar, Screen, StatusBar, TabBar } from '../components/chrome';
import { Meta, Panel } from '../components/ui';

export function ChartScreen() {
  return (
    <Screen label="02 · CHART">
      <StatusBar />
      <BrandBar />

      <Body>
        <Meta className="mt-7.5 tracking-w20">MARKET DATA</Meta>
        
        <Panel className="mt-6 h-64 p-4 border border-hairline relative justify-between overflow-hidden">
          <View className="absolute inset-0 opacity-10">
            <View className="h-full w-full flex-row">
              <View className="flex-1 border-r border-hairline" />
              <View className="flex-1 border-r border-hairline" />
              <View className="flex-1 border-r border-hairline" />
              <View className="flex-1" />
            </View>
          </View>
          
          <View className="flex-row justify-between">
            <Text className="font-mono text-14 text-bone">SOL-USD</Text>
            <Text className="font-mono text-14 text-signal">132.45</Text>
          </View>

          <View className="h-32 border-b border-hairline relative">
            {/* Mock price line */}
            <View className="absolute bottom-4 left-0 right-0 h-px bg-signal opacity-80" />
            <View className="absolute bottom-8 left-10 w-2 h-12 bg-refused" />
            <View className="absolute bottom-2 left-24 w-2 h-16 bg-signal" />
            <View className="absolute bottom-6 left-40 w-2 h-10 bg-refused" />
            <View className="absolute bottom-12 left-56 w-2 h-20 bg-signal" />
          </View>

          <View className="flex-row justify-between pt-2">
            <Text className="font-mono text-9 text-ash">1H</Text>
            <Text className="font-mono text-9 text-ash">4H</Text>
            <Text className="font-mono text-9 text-ash">1D</Text>
            <Text className="font-mono text-9 text-ash">1W</Text>
          </View>
        </Panel>
      </Body>

      <TabBar active="chart" />
    </Screen>
  );
}
