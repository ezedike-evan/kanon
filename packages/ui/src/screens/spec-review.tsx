import { Fragment, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Body, Footer, NavBar, Screen } from '../components/chrome';
import { ParamSheet } from '../components/param-sheet';
import { Dot, Num, PrimaryButton } from '../components/ui';
import { useNavigator } from '../nav';
import { CHANGE_TAG, formatChangeValue } from '../lib/change-format';
import { useKanonData } from '../lib/data';
import { loosenRoute, routes } from '../lib/routes';
import { cx } from '../lib/cx';

type View_ = 'plain' | 'parametric';

/**
 * 03 · SPEC REVIEW.
 *
 * Compilation is always reviewed, never silent. Two registers: plain English by
 * default, parametric one toggle away. Every default the compiler chose is
 * listed by name and can be changed in place — a user who discovers an unseen
 * parameter later is a permanent loss of trust, so there is nowhere for one to
 * hide.
 *
 * Nothing is pinned from here without an explicit sign-off: the user confirms
 * they have read the spec, defaults included, before the pin ceremony opens.
 * On a pinned rule the same screen stages a change and says, before it is sent,
 * whether it applies now or waits.
 */
export function SpecReviewScreen() {
  const nav = useNavigator();
  const { review: REVIEW, editParam, acknowledgeReview, submitAmendment, rule } = useKanonData();
  const [view, setView] = useState<View_>('plain');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const editable = REVIEW.mode === 'draft' || REVIEW.mode === 'amend';
  const editing = REVIEW.params.find((p) => p.key === editingKey) ?? null;
  const open = (key: string | undefined) => {
    if (editable && key) setEditingKey(key);
  };

  if (REVIEW.mode === 'empty') {
    return (
      <Screen label="03 · SPEC REVIEW">
        <NavBar left="REVIEW SPEC" leftHref={routes.home} right="NOTHING YET" />
        <Body contentClassName="justify-center">
          <Text className="font-mono text-9 tracking-w20 text-ash">NO SPEC</Text>
          <Text className="mt-3 font-sans text-24 font-medium tracking-t20 text-bone leading-[1.15]">
            There is nothing to review yet.
          </Text>
          <Text className="mt-3.5 font-sans text-14 text-ash leading-[1.5]">
            Describe the rule you keep breaking. It is compiled into a spec, and you read it here
            before anything is pinned.
          </Text>
        </Body>
        <Footer>
          <PrimaryButton href={routes.compile}>DESCRIBE A RULE</PrimaryButton>
        </Footer>
      </Screen>
    );
  }

  const preview = REVIEW.preview;
  const staged = REVIEW.mode === 'amend';

  async function send() {
    setNotice(null);
    const out = await submitAmendment();
    if (!out.ok) {
      setNotice(out.message);
      return;
    }
    nav.replace(out.kind === 'cooling_off' ? loosenRoute(rule.id) : routes.home);
  }

  return (
    <Screen label="03 · SPEC REVIEW">
      <NavBar
        left={staged ? 'AMEND RULE' : 'REVIEW SPEC'}
        leftHref={staged ? routes.home : routes.compile}
        right="CLOSE ✕"
      />

      <View className="mx-5 mt-5 shrink-0 flex-row overflow-hidden rounded-[2px] border border-hairline">
        {(['plain', 'parametric'] as const).map((key) => (
          <Pressable
            key={key}
            onPress={() => setView(key)}
            role="button"
            aria-pressed={view === key}
            className={cx('flex-1 items-center py-2.75', view === key && 'bg-raised')}
          >
            <Text
              className={cx(
                'font-mono text-11 tracking-w12',
                view === key ? 'text-bone' : 'text-ash',
              )}
            >
              {key === 'plain' ? 'PLAIN ENGLISH' : 'PARAMETRIC'}
            </Text>
          </Pressable>
        ))}
      </View>

      <Body contentClassName="pt-6.5">
        {view === 'plain' ? (
          <View className="gap-5.5">
            {REVIEW.plain.map((segments, i) => (
              <Fragment key={i}>
                {i > 0 ? <View className="h-px bg-hairline" /> : null}
                <View className="gap-2.5">
                  <Text className="font-mono text-9 tracking-w20 text-ash">
                    {i === REVIEW.plain.length - 1 && editable
                      ? 'RISK'
                      : `PREDICATE ${String(i + 1).padStart(2, '0')}`}
                  </Text>
                  <Text className="font-sans text-15 text-bone leading-[1.6]">
                    {segments.map((segment, j) =>
                      typeof segment === 'string' ? (
                        <Text key={j}>{segment}</Text>
                      ) : (
                        /* Bound parameters are editable in place. No hidden defaults. */
                        <Text
                          key={j}
                          onPress={() => open(segment.key)}
                          className="font-mono text-13 text-signal underline decoration-signal"
                          role="button"
                        >
                          {segment.param}
                        </Text>
                      ),
                    )}
                  </Text>
                </View>
              </Fragment>
            ))}
          </View>
        ) : (
          <View>
            {REVIEW.parametric.map((line, i) => (
              <View key={`${i}-${line}`} className="flex-row gap-3">
                <Num className="w-4 text-12 text-hairline leading-[1.85]">
                  {String(i + 1).padStart(2, '0')}
                </Num>
                <Text className="flex-1 font-mono text-12 text-ash leading-[1.85]">
                  {line}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Surfaced in both registers: an inferred default is never silent. */}
        {REVIEW.inferred.length > 0 ? (
          <View className="mt-5 mb-5 border border-inferred-edge bg-inferred-wash p-3.5">
            <View className="flex-row items-center gap-2.25">
              <Dot className="bg-signal" />
              <Text className="font-mono text-9 tracking-w18 text-signal">
                {REVIEW.inferred.length} {REVIEW.inferred.length === 1 ? 'DEFAULT' : 'DEFAULTS'} INFERRED
              </Text>
            </View>
            <View className="mt-2.75 gap-1.75">
              {REVIEW.inferred.map((d) => (
                <Pressable
                  key={d.key ?? d.name}
                  onPress={() => open(d.key)}
                  disabled={!editable || !d.key}
                  role="button"
                  aria-label={`Edit ${d.name}`}
                  className="flex-row justify-between gap-3"
                >
                  <Text className="flex-1 font-mono text-11p5 text-ash leading-[1.5]">
                    {d.name}
                  </Text>
                  <Text className="font-mono text-11p5 text-ash leading-[1.5]">
                    <Num className="text-11p5 text-bone">{d.value}</Num>
                    {editable ? '   — edit' : '   — not stated'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <View className="mt-5 mb-5 border border-hairline p-3.5">
            <Text className="font-mono text-9 tracking-w18 text-ash">NO DEFAULTS INFERRED</Text>
            <Text className="mt-2 font-mono text-11p5 text-ash leading-[1.5]">
              Every parameter above was stated by you.
            </Text>
          </View>
        )}

        {/* A pinned rule with a staged change: what it does, before it is sent. */}
        {staged && preview && preview.kind !== 'none' ? (
          <View className="mb-5 border border-hairline bg-panel">
            <View className="border-b border-hairline px-3.5 py-3">
              <Text
                className={cx(
                  'font-mono text-9 tracking-w18',
                  preview.kind === 'cooling_off' ? 'text-signal' : 'text-bone',
                )}
              >
                {preview.kind === 'cooling_off'
                  ? `LOOSENING · ${Math.round(preview.cooldownSeconds / 3600)} HOUR HOLD`
                  : 'TIGHTENING · APPLIES IMMEDIATELY'}
              </Text>
              <Text className="mt-1.5 font-sans text-13 text-ash leading-[1.5]">
                {preview.kind === 'cooling_off'
                  ? 'The current rule stays enforced until the hold has run. Nothing about it changes while you wait.'
                  : 'A stricter rule takes effect the moment it is sent.'}
              </Text>
            </View>
            {preview.changes.map((change, i) => (
              <View
                key={change.path}
                className={cx(
                  'flex-row items-center justify-between gap-3 px-3.5 py-3',
                  i < preview.changes.length - 1 && 'border-b border-hairline',
                )}
              >
                <View className="flex-1 gap-1">
                  <Text className="font-mono text-12 text-ash">{change.path}</Text>
                  <Text className="font-mono text-9 tracking-w14 text-ash">{CHANGE_TAG[change.kind]}</Text>
                </View>
                <View className="flex-row items-baseline gap-2.5">
                  <Num className="text-12 text-ash line-through">
                    {formatChangeValue(change.path, change.before)}
                  </Num>
                  <Text className="font-mono text-11 text-ash" aria-hidden>→</Text>
                  <Num className="font-mono-medium text-13 text-signal">
                    {formatChangeValue(change.path, change.after)}
                  </Num>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {REVIEW.error || notice ? (
          <Text className="mb-5 font-mono text-11 text-signal leading-[1.5]" role="alert">
            {REVIEW.error ?? notice}
          </Text>
        ) : null}
      </Body>

      <Footer className="border-t border-hairline pt-5">
        {REVIEW.mode === 'draft' ? (
          <>
            {/* The sign-off. The pin ceremony does not open without it. */}
            <Pressable
              onPress={() => acknowledgeReview(!REVIEW.acknowledged)}
              role="checkbox"
              aria-checked={REVIEW.acknowledged}
              className="mb-4 flex-row items-start gap-3"
            >
              <View
                className={cx(
                  'mt-0.5 size-4.5 items-center justify-center border',
                  REVIEW.acknowledged ? 'border-signal bg-signal' : 'border-hairline',
                )}
              >
                <Text className="font-mono-bold text-11 text-void" aria-hidden>
                  {REVIEW.acknowledged ? '✓' : ''}
                </Text>
              </View>
              <Text className="flex-1 font-sans text-13 text-bone leading-[1.5]">
                I have read this spec
                {REVIEW.inferred.length > 0
                  ? `, including the ${REVIEW.inferred.length} ${REVIEW.inferred.length === 1 ? 'default' : 'defaults'} the compiler chose.`
                  : '.'}
              </Text>
            </Pressable>
            <View className="mb-4 flex-row items-center justify-between">
              <Text className="font-mono text-10 tracking-w10 text-ash">ENFORCEMENT</Text>
              <Text className="font-mono text-10 tracking-w10 text-bone">IMMEDIATE ON PIN</Text>
            </View>
            <PrimaryButton
              onPress={() => nav.push(routes.compilePin)}
              disabled={!REVIEW.acknowledged}
            >
              PIN ON-CHAIN
            </PrimaryButton>
          </>
        ) : REVIEW.mode === 'amend' ? (
          <>
            <View className="mb-4 flex-row items-center justify-between">
              <Text className="font-mono text-10 tracking-w10 text-ash">CHANGE</Text>
              <Text className="font-mono text-10 tracking-w10 text-bone">
                {!preview || preview.kind === 'none'
                  ? 'NONE STAGED'
                  : preview.kind === 'cooling_off'
                    ? `HELD ${Math.round(preview.cooldownSeconds / 3600)}H`
                    : 'IMMEDIATE'}
              </Text>
            </View>
            <PrimaryButton
              onPress={send}
              disabled={!preview || preview.kind === 'none' || REVIEW.busy}
            >
              {REVIEW.busy ? 'SENDING' : 'SEND CHANGE'}
            </PrimaryButton>
          </>
        ) : (
          <>
            <View className="mb-4 flex-row items-center justify-between">
              <Text className="font-mono text-10 tracking-w10 text-ash">ENFORCEMENT</Text>
              <Text className="font-mono text-10 tracking-w10 text-bone">IMMEDIATE ON PIN</Text>
            </View>
            <PrimaryButton href={routes.compilePin}>PIN ON-CHAIN</PrimaryButton>
          </>
        )}
      </Footer>

      <ParamSheet
        param={editing}
        onClose={() => setEditingKey(null)}
        onSubmit={(value) => (editingKey ? editParam(editingKey, value) : { ok: false, error: '' })}
      />
    </Screen>
  );
}
