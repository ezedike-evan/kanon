import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { COOLING_OFF_SECONDS } from '@kanon/spec';
import { Badge } from '../components/badge';
import { BottomSheet } from '../components/bottom-sheet';
import { Card } from '../components/card';
import { ListRow } from '../components/list-row';
import { ContractSheet, CopyButton, Fact, SignOutSheet, SubScreen } from '../components/profile-parts';
import { SectionHeader } from '../components/section-header';
import { Body } from '../components/chrome';
import { GhostButton, Num } from '../components/ui';
import { useAccount } from '../lib/account';
import { useSession } from '../lib/domains';
import { monad } from '../lib/monad-chain';
import { explorerUrl, loginLabel } from '../lib/profile-logic';
import { routes } from '../lib/routes';
import { usePlatform } from '../platform';

/**
 * 15C · SECURITY.
 *
 * The wallet that signs, stated plainly: its address, the network, whether it is
 * the wallet made at sign-up, and what it signs. Where a capability does not
 * exist on this platform, it says so instead of showing a switch that does
 * nothing: a browser has no device passkey, and this screen does not pretend it
 * does. Nothing here changes a pinned rule.
 */

const HOURS = Math.round(COOLING_OFF_SECONDS / 3600);

const SIGNS: ReadonlyArray<readonly [string, string]> = [
  ['Every pin is signed by your wallet.', 'The rule is written on-chain with your signature and a bond.'],
  ['Every loosening is signed by your wallet.', `It then waits ${HOURS} hours, in view. Nothing skips the wait.`],
  ['Tightening is signed too.', 'It applies at once: a stricter rule needs no cooling-off.'],
  ['The contract checks the signature and the arithmetic.', 'It never calls a model, and there is no admin key or override.'],
];

type Check = 'idle' | 'busy' | 'ok' | 'no';

export function ProfileSecurityScreen() {
  const account = useAccount();
  const session = useSession();
  const { hasBiometrics, authenticate } = usePlatform();
  const [sheet, setSheet] = useState<null | 'signout' | 'contract' | 'export'>(null);
  const [check, setCheck] = useState<Check>('idle');
  const [exportFailed, setExportFailed] = useState(false);

  const { address, walletKind } = account;
  const demo = !session.pending && !session.signedIn;

  const testPasskey = async () => {
    if (check === 'busy') return;
    setCheck('busy');
    try {
      setCheck((await authenticate('Confirm it is you')) ? 'ok' : 'no');
    } catch {
      setCheck('no');
    }
  };

  const runExport = async () => {
    setExportFailed(false);
    try {
      await account.exportWallet?.();
      setSheet(null);
    } catch {
      setExportFailed(true);
    }
  };

  const walletLabel =
    walletKind === 'embedded'
      ? 'Privy embedded wallet'
      : walletKind === 'external'
        ? 'Wallet you connected'
        : demo
          ? 'None in the demo'
          : 'Not created yet';

  return (
    <SubScreen
      label="15C · SECURITY"
      title="Wallet and signing"
      overlay={
        <>
          <SignOutSheet open={sheet === 'signout'} onClose={() => setSheet(null)} />
          <ContractSheet open={sheet === 'contract'} onClose={() => setSheet(null)} />
          <BottomSheet open={sheet === 'export'} onClose={() => setSheet(null)} title="EXPORT WALLET KEY">
            <View className="gap-4 pb-2">
              <Text className="font-sans text-14 leading-[1.5] text-bone">
                Privy opens its own window and shows the key there. Kanon never sees it.
              </Text>
              <Text className="font-sans text-13 leading-[1.5] text-ash">
                Anyone who holds the key controls this wallet. Keep it offline. Exporting does not change a pinned rule:
                the contract still enforces it, and a loosening still waits {HOURS} hours.
              </Text>
              {exportFailed ? (
                <Text role="alert" className="font-sans text-13 text-ash">
                  The export did not open. Try again.
                </Text>
              ) : null}
              <GhostButton onPress={runExport}>CONTINUE TO PRIVY</GhostButton>
            </View>
          </BottomSheet>
        </>
      }
      right={demo ? <Badge label="Demo" tone="signal" icon="sparkles" /> : null}
    >
      <Body contentClassName="gap-6 pb-8 pt-2">
        <View className="gap-2.5">
          <SectionHeader title="Wallet" />
          <Card pad="none">
            <Fact
              label="Address"
              value={address ?? (demo ? 'Sign in to get a wallet' : 'No address yet')}
              mono={Boolean(address)}
              right={address ? <CopyButton value={address} label="wallet address" /> : null}
            />
            <Fact label="Wallet" value={walletLabel} mono={false} sub={walletKind === 'embedded' ? 'Made when you signed up. Only you can sign with it.' : undefined} />
            <Fact
              label="Network"
              value={`${monad.name} · chain ${monad.id}`}
              sub="Read-only. Rules are pinned on this chain."
            />
            {account.loginMethods.length > 0 ? (
              <Fact label="Signed in with" value={account.loginMethods.map(loginLabel).join(', ')} mono={false} />
            ) : null}
            {address ? (
              <ListRow
                leading="external-link"
                title={`View on ${monad.blockExplorers.default.name}`}
                subtitle="Balances and every transaction this wallet signed"
                onPress={() =>
                  void Linking.openURL(explorerUrl(monad.blockExplorers.default.url, 'address', address))
                }
                divider={false}
              />
            ) : demo ? (
              <ListRow leading="key" title="Sign in" subtitle="A wallet is made when you do" href={routes.landing} divider={false} />
            ) : null}
          </Card>
        </View>

        <View className="gap-2.5">
          <SectionHeader title="Passkey and biometrics" />
          <Card pad="md" className="gap-3">
            <View className="flex-row items-center justify-between gap-3">
              <Text className="font-sans text-14 font-medium text-bone">Device passkey</Text>
              <Badge
                label={hasBiometrics ? 'Available' : 'Not in the browser'}
                tone={hasBiometrics ? 'signal' : 'neutral'}
                icon={hasBiometrics ? 'fingerprint' : 'info'}
              />
            </View>
            {hasBiometrics ? (
              <>
                <Text className="font-sans text-13 leading-[1.5] text-ash">
                  The pinning ceremony asks this device to confirm it is you before it signs. Try it here without pinning anything.
                </Text>
                <GhostButton onPress={() => void testPasskey()} disabled={check === 'busy'}>
                  {check === 'busy' ? 'WAITING FOR THE DEVICE' : 'TEST THE PROMPT'}
                </GhostButton>
                {check === 'ok' ? (
                  <Text role="status" className="font-sans text-13 text-bone">
                    Confirmed. This device can vouch for you.
                  </Text>
                ) : check === 'no' ? (
                  <Text role="status" className="font-sans text-13 text-ash">
                    Not confirmed. Check that a fingerprint or face is enrolled in this device&apos;s settings.
                  </Text>
                ) : null}
              </>
            ) : (
              <Text className="font-sans text-13 leading-[1.5] text-ash">
                A browser has no device passkey, so here a pin is signed by your wallet alone. Open Kanon on your phone to
                add a fingerprint or face check to the ceremony.
              </Text>
            )}
          </Card>
        </View>

        <View className="gap-2.5">
          <SectionHeader title="What signs what" />
          <Card pad="md" className="gap-4">
            {SIGNS.map(([lead, body], i) => (
              <View key={lead} className="flex-row gap-3">
                <Num className="w-5 pt-0.5 text-11 text-signal">{String(i + 1).padStart(2, '0')}</Num>
                <View className="flex-1 gap-1">
                  <Text className="font-sans text-14 font-medium text-bone">{lead}</Text>
                  <Text className="font-sans text-13 leading-[1.5] text-ash">{body}</Text>
                </View>
              </View>
            ))}
          </Card>
          <Card pad="none">
            <ListRow
              leading="info"
              title="What the contract enforces"
              subtitle="The security model, in plain words"
              onPress={() => setSheet('contract')}
              divider={false}
            />
          </Card>
        </View>

        {account.exportWallet ? (
          <View className="gap-2.5">
            <SectionHeader title="Backup" />
            <Card pad="none">
              <ListRow
                leading="download"
                title="Export wallet key"
                subtitle="Opens Privy's own window. Kanon never sees the key"
                onPress={() => {
                  setExportFailed(false);
                  setSheet('export');
                }}
                divider={false}
              />
            </Card>
          </View>
        ) : null}

        <View className="gap-2.5">
          <SectionHeader title="Session" />
          <Card pad="none">
            {session.signedIn ? (
              <ListRow
                leading="log-out"
                title="Sign out"
                subtitle="Ends this session on this device"
                onPress={() => setSheet('signout')}
                destructive
                divider={false}
              />
            ) : (
              <ListRow leading="key" title="Sign in" subtitle="Pin rules, trade and keep your record" href={routes.landing} divider={false} />
            )}
          </Card>
          <Text className="px-0.5 font-sans text-12 leading-[1.5] text-ash">
            Nothing on this screen changes a pinned rule. Signing out or exporting a key leaves it enforced on-chain.
          </Text>
        </View>
      </Body>
    </SubScreen>
  );
}
