import { useState, useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { AuthModal } from '@kanon/ui';
import { colors } from '@kanon/tokens';
import { useLoginWithEmail, usePrivy } from '@privy-io/expo';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { api } from '@kanon/backend';

export default function MobileLandingPage() {
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const router = useRouter();

  const { sendCode, loginWithCode } = useLoginWithEmail();
  const { user, isReady } = usePrivy();
  const createUser = useMutation(api.users.createUser);

  // Mirrors apps/web/src/components/marketing-content.tsx: look up the
  // Convex `users` row (`users.me`, found from the Privy token) once Privy resolves a user, and use its
  // absence to force the auth modal to its "complete profile" step (2) for a
  // first-time signup rather than treating a bare Privy session as done.
  // Skipped until Convex has accepted the Privy token: an unauthenticated
  // `users.me` also answers null, which must not read as "new user".
  const { isAuthenticated: convexAuthed } = useConvexAuth();
  const dbUser = useQuery(api.users.me, convexAuthed ? {} : 'skip');
  const isNewUser = isReady && !!user && dbUser === null;
  const isExistingUser = isReady && !!user && dbUser !== null && dbUser !== undefined;
  const forceStep = isNewUser ? 2 : undefined;

  useEffect(() => {
    if (isNewUser) {
      setIsAuthModalOpen(true);
    }
  }, [isNewUser]);

  // Only an already-registered user is redirected straight to the app —
  // mobile has no header/username affordance to return here later, so this
  // redirect stands in for that, but it must wait for `dbUser` to resolve
  // rather than firing on a bare Privy session (which would skip step 2 for
  // a first-time signup before a `users` row exists).
  useEffect(() => {
    if (isExistingUser) {
      router.replace('/home');
    }
  }, [isExistingUser, router]);

  // Mock handlers for social/passkey on mobile until fully wired up
  const handleSocialLogin = (provider: 'google' | 'twitter') => {
    console.log(`Mobile: Logging in with ${provider}`);
  };

  const handlePasskeyLogin = async () => {
    console.log('Mobile: Logging in with Passkey');
  };

  const handleSendEmailCode = async (email: string) => {
    setIsSendingCode(true);
    try {
      await sendCode({ email });
    } catch (e) {
      console.error('Mobile: Failed to send code', e);
      throw e; // Bubble up so AuthModal knows it failed
    } finally {
      setIsSendingCode(false);
    }
  };

  const handleVerifyEmailCode = async (code: string) => {
    setIsVerifyingCode(true);
    try {
      await loginWithCode({ code });
      // Do not close the modal or navigate here: `isNewUser`/`isExistingUser`
      // above (derived from the resolved `dbUser`) decide what happens next
      // — step 2 for a first-time signup, or a redirect for a returning one.
    } catch (e) {
      console.error('Mobile: Failed to verify code', e);
      throw e;
    } finally {
      setIsVerifyingCode(false);
    }
  };

  const handleCompleteProfile = async (data: { name: string; username: string; experience: string }) => {
    if (!user) return;

    // No privyId: the server binds the row to the token's subject.
    const createUserPayload: {
      name: string;
      username: string;
      experience: string;
      email?: string;
    } = {
      name: data.name,
      username: data.username,
      experience: data.experience,
    };

    // `linked_accounts` is a discriminated union; Privy's expo SDK does not
    // re-export the individual `LinkedAccountEmail` member type, so this
    // narrows structurally rather than nominally.
    const emailAccount = user.linked_accounts.find((account) => account.type === 'email') as
      | { type: 'email'; address: string }
      | undefined;
    if (emailAccount) {
      createUserPayload.email = emailAccount.address;
    }

    await createUser(createUserPayload);

    setIsAuthModalOpen(false);
    router.replace('/home');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.void, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
      
      <View style={{ marginBottom: 40, alignItems: 'center' }}>
        <Text style={{ fontFamily: 'JetBrainsMono_700Bold', fontSize: 24, color: colors.bone, letterSpacing: 4, textTransform: 'uppercase', marginBottom: 16 }}>
          Kanon
        </Text>
        <Text style={{ fontFamily: 'JetBrainsMono_400Regular', fontSize: 14, color: colors.ash, textAlign: 'center', lineHeight: 22 }}>
          Your trading strategy, compiled into a contract that refuses trades breaking your own rules.
        </Text>
      </View>

      <Pressable 
        onPress={() => setIsAuthModalOpen(true)}
        style={{
          backgroundColor: '#D4A01726', // tint with opacity
          borderColor: '#D4A017',
          borderWidth: 1,
          paddingVertical: 16,
          paddingHorizontal: 32,
          borderRadius: 8,
        }}
      >
        <Text style={{ fontFamily: 'JetBrainsMono_700Bold', color: '#D4A017', letterSpacing: 2, textTransform: 'uppercase' }}>
          Launch App
        </Text>
      </Pressable>

      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onSocialLogin={handleSocialLogin}
        onPasskeyLogin={handlePasskeyLogin}
        onSendEmailCode={handleSendEmailCode}
        onVerifyEmailCode={handleVerifyEmailCode}
        onCompleteProfile={handleCompleteProfile}
        isSendingCode={isSendingCode}
        isVerifyingCode={isVerifyingCode}
        {...(forceStep !== undefined ? { forceStep } : {})}
      />
    </View>
  );
}
