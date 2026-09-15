import { useState, useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { AuthModal } from '@kanon/ui';
import { colors } from '@kanon/tokens';
import { useLoginWithEmail, usePrivy } from '@privy-io/expo';

export default function MobileLandingPage() {
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const router = useRouter();

  const { sendCode, loginWithCode } = useLoginWithEmail();
  const { user, isReady } = usePrivy();

  // Redirect if already logged in (optional, matching web)
  useEffect(() => {
    if (isReady && user) {
      router.replace('/home');
    }
  }, [isReady, user, router]);

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
      setIsAuthModalOpen(false);
      router.replace('/home');
    } catch (e) {
      console.error('Mobile: Failed to verify code', e);
      throw e;
    } finally {
      setIsVerifyingCode(false);
    }
  };

  const handleCompleteProfile = async (data: { name: string; username: string; experience: string }) => {
    console.log('Mobile: Completed profile', data);
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
      />
    </View>
  );
}
