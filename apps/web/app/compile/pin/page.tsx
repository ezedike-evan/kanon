import { formatDecimal } from '@kanon/spec';
import { Body, Footer, NavBar, Screen } from '@/components/chrome';
import { Dot, Meta, Num, PrimaryButton } from '@/components/ui';
import { PINNING, RULE } from '@/lib/demo';

/**
 * 04 · PINNING CEREMONY.
 *
 * Deliberately weighted. The hash, the bond and the three things you are
 * agreeing to, then a biometric signature. There is no admin key and no support
 * path behind this screen: what you agree to here is what gets enforced.
 */
export default function PinningPage() {
  return (
    <Screen label="04 · PINNING CEREMONY">
      <NavBar
        left="PINNING"
        leftClassName="text-signal"
        leftHref="/compile/review"
        right={PINNING.step}
      />

      <Body>
        <h1 className="mt-10 text-30 leading-[1.1] font-medium tracking-t25 text-pretty">
          You are writing this rule into a contract.
        </h1>

        <div className="mt-7.5 border-t border-hairline">
          <div className="flex items-baseline justify-between gap-4 border-b border-hairline py-3.5">
            <Meta className="shrink-0">SPEC HASH</Meta>
            <Num className="text-12 break-all text-right">{RULE.specHash}</Num>
          </div>
          <div className="flex items-baseline justify-between border-b border-hairline py-3.5">
            <Meta>CONTRACT</Meta>
            <Num className="text-12">{RULE.contract}</Num>
          </div>
          <div className="flex items-end justify-between border-b border-hairline py-4">
            <div className="flex flex-col gap-1.75">
              <Meta>BOND POSTED</Meta>
              <span className="font-mono text-10 tracking-w10 text-ash">
                RETURNED ON UNPIN
              </span>
            </div>
            <Num className="text-31 font-medium tracking-t30 text-signal">
              {formatDecimal(PINNING.bond)}{' '}
              <span className="text-15 tracking-w04">{PINNING.bondUnit}</span>
            </Num>
          </div>
        </div>

        <div className="mt-6.5 mb-5 flex flex-col gap-3">
          <span className="font-mono text-9 tracking-w20 text-ash">
            YOU ARE AGREEING THAT
          </span>
          {PINNING.agreements.map((line) => (
            <div key={line} className="flex gap-2.75">
              <Dot className="mt-1.75 bg-signal" />
              <span className="text-14p5 leading-[1.5] text-pretty">{line}</span>
            </div>
          ))}
        </div>
      </Body>

      <Footer>
        <div className="mb-4.5 flex items-center gap-3.5 border-t border-hairline py-4">
          <div className="flex size-9.5 shrink-0 items-center justify-center rounded-full border border-signal">
            <div className="size-3 rounded-full border border-signal" />
          </div>
          <div className="flex flex-col gap-1.25">
            <span className="font-mono text-11 tracking-w10">FACE ID REQUIRED</span>
            <span className="font-mono text-10 tracking-w06 text-ash">
              Signs with your device passkey
            </span>
          </div>
        </div>
        <PrimaryButton href="/" className="py-5 tracking-w20">
          HOLD TO SIGN
        </PrimaryButton>
      </Footer>
    </Screen>
  );
}
