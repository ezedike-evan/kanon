import { Text, View, TextInput } from 'react-native';
import { Body, Footer, Screen, StatusBar, TabBar } from '../components/chrome';
import { Dot, Meta, Panel } from '../components/ui';
import { cx } from '../lib/cx';

export function CreateScreen() {
  return (
    <Screen label="CREATE RULE">
      <StatusBar />
      
      <View className="shrink-0 flex-row items-center justify-between border-b border-hairline px-5 pt-5 pb-4">
        <Text className="font-mono text-11 tracking-w16 text-bone">AI STRATEGY COMPILER</Text>
        <Text className="font-mono text-10 tracking-w12 text-signal">READY</Text>
      </View>

      <Body className="bg-canvas">
        {/* Mock AI Charting / Strategy Interface */}
        <View className="mt-6 gap-6">
          <Panel>
            <View className="border-b border-hairline px-4 pt-4 pb-3.5 flex-row justify-between">
              <Meta>GENERATED LOGIC</Meta>
              <Dot className="bg-signal" />
            </View>
            <View className="p-4 gap-3">
              <View className="flex-row items-center justify-between">
                <Text className="font-mono text-11 text-ash">ASSET</Text>
                <Text className="font-mono-medium text-14 text-bone">SOL-USD</Text>
              </View>
              <View className="flex-row items-center justify-between">
                <Text className="font-mono text-11 text-ash">TIMEFRAME</Text>
                <Text className="font-mono-medium text-14 text-bone">1H</Text>
              </View>
              <View className="flex-row items-center justify-between">
                <Text className="font-mono text-11 text-ash">CONDITION</Text>
                <Text className="font-mono-medium text-14 text-signal">EMA(20) CROSSOVER EMA(50)</Text>
              </View>
            </View>
          </Panel>

          {/* Minimalist Chart Grid Placeholder */}
          <View className="h-48 border border-hairline bg-void relative overflow-hidden">
            <View className="absolute inset-0 opacity-20">
              <View className="h-full w-full flex-row">
                <View className="flex-1 border-r border-hairline" />
                <View className="flex-1 border-r border-hairline" />
                <View className="flex-1 border-r border-hairline" />
                <View className="flex-1" />
              </View>
            </View>
            <View className="absolute bottom-8 left-0 right-0 h-0.5 bg-signal opacity-50" />
            <View className="absolute bottom-16 left-0 right-0 h-0.5 bg-signal opacity-80 transform -rotate-12" />
            <Text className="absolute bottom-3 right-3 font-mono text-9 text-ash">PREVIEW ONLY</Text>
          </View>
        </View>
      </Body>

      <Footer className="border-t border-hairline bg-panel pt-4">
        <View className="flex-row items-center rounded-sm border border-hairline bg-void px-3.5 py-3">
          <Text className="font-mono text-12 text-ash mr-2">{'>'}</Text>
          <TextInput
            className="flex-1 font-mono text-12 text-bone"
            placeholder="Describe your strategy..."
            placeholderTextColor="#666"
            readOnly
            value="When SOL 1H EMA 20 crosses..."
          />
        </View>
      </Footer>

      <TabBar active="create" />
    </Screen>
  );
}
