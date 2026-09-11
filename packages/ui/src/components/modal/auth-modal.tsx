'use client';

import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, Platform } from 'react-native';
import { PrimaryButton } from '../ui';
import { cx } from '../../lib/cx';

export interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AuthModal({ isOpen, onClose }: AuthModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [privacyAgreed, setPrivacyAgreed] = useState(false);

  if (!isOpen) return null;

  return (
    <View 
      className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-void/80" 
      style={Platform.OS === 'web' ? { backdropFilter: 'blur(12px)' } as any : undefined}
    >
      <Pressable className="absolute inset-0" onPress={onClose} />
      
      <View className="w-full max-w-md bg-panel border border-hairline overflow-hidden p-8" style={{ shadowColor: '#D4A017', shadowOpacity: 0.1, shadowRadius: 40, elevation: 10 }}>
        <Pressable onPress={onClose} className="absolute top-4 right-4 p-2 z-10">
          <Text className="text-ash hover:text-bone text-lg font-mono">✕</Text>
        </Pressable>

        {step === 1 && (
          <View>
            <Text className="text-24 font-bold text-bone uppercase tracking-widest mb-2">Welcome</Text>
            <Text className="text-ash text-14 mb-8">Sign in or create an account to pin your strategy.</Text>
            
            <View className="gap-4">
              <TextInput 
                placeholder="Email address" 
                placeholderTextColor="#8A949E"
                className="w-full bg-void border border-hairline text-bone px-4 py-3 text-14 focus:border-signal" 
              />
              <TextInput 
                placeholder="Password" 
                placeholderTextColor="#8A949E"
                secureTextEntry
                className="w-full bg-void border border-hairline text-bone px-4 py-3 text-14 focus:border-signal" 
              />
              <PrimaryButton onPress={() => setStep(2)}>
                Continue with Email
              </PrimaryButton>
            </View>

            <View className="flex-row items-center justify-center gap-4 my-8">
              <View className="h-px bg-hairline flex-1" />
              <Text className="text-ash text-12 uppercase tracking-widest font-mono">Or</Text>
              <View className="h-px bg-hairline flex-1" />
            </View>

            <View className="gap-3">
              <Pressable onPress={onClose} className="w-full flex-row items-center justify-center gap-3 border border-hairline bg-void/50 py-4 hover:bg-hairline/30 active:bg-hairline/50 transition-colors">
                <Text className="text-bone text-14 font-mono">Continue with Google</Text>
              </Pressable>
              <Pressable onPress={onClose} className="w-full flex-row items-center justify-center gap-3 border border-hairline bg-void/50 py-4 hover:bg-hairline/30 active:bg-hairline/50 transition-colors">
                <Text className="text-bone text-14 font-mono">Continue with X</Text>
              </Pressable>
              <Pressable onPress={onClose} className="w-full flex-row items-center justify-center gap-3 border border-signal bg-signal/10 py-4 mt-2 hover:bg-signal/20 active:bg-signal/30 transition-colors">
                <Text className="text-signal text-14 font-mono-bold uppercase tracking-widest">Continue with Passkey</Text>
              </Pressable>
            </View>
          </View>
        )}

        {step === 2 && (
          <View>
            <Pressable onPress={() => setStep(1)} className="mb-6 self-start p-1 -ml-1">
              <Text className="text-ash text-14 font-mono">← Back</Text>
            </Pressable>
            <Text className="text-24 font-bold text-bone uppercase tracking-widest mb-2">Basic Info</Text>
            <Text className="text-ash text-14 mb-8">Tell us a bit about yourself to tailor your experience.</Text>
            
            <View className="gap-5">
              <View>
                <Text className="text-ash text-11 uppercase tracking-widest mb-2 font-mono">Full Name</Text>
                <TextInput 
                  placeholder="John Doe" 
                  placeholderTextColor="#8A949E"
                  className="w-full bg-void border border-hairline text-bone px-4 py-3 text-14 focus:border-signal" 
                />
              </View>
              <View>
                <Text className="text-ash text-11 uppercase tracking-widest mb-2 font-mono">Username</Text>
                <View className="flex-row">
                  <View className="bg-hairline/20 border border-hairline border-r-0 px-4 justify-center">
                    <Text className="text-ash text-14 font-mono">@</Text>
                  </View>
                  <TextInput 
                    placeholder="trader" 
                    placeholderTextColor="#8A949E"
                    className="flex-1 bg-void border border-hairline text-bone px-4 py-3 text-14 focus:border-signal" 
                  />
                </View>
              </View>
              <View>
                <Text className="text-ash text-11 uppercase tracking-widest mb-2 font-mono">Trading Experience (Years)</Text>
                <TextInput 
                  placeholder="e.g. 3" 
                  placeholderTextColor="#8A949E"
                  keyboardType="numeric"
                  className="w-full bg-void border border-hairline text-bone px-4 py-3 text-14 focus:border-signal" 
                />
              </View>
              <View className="pt-4">
                <PrimaryButton onPress={() => setStep(3)}>
                  Continue
                </PrimaryButton>
              </View>
            </View>
          </View>
        )}

        {step === 3 && (
          <View>
            <Pressable onPress={() => setStep(2)} className="mb-6 self-start p-1 -ml-1">
              <Text className="text-ash text-14 font-mono">← Back</Text>
            </Pressable>
            <Text className="text-24 font-bold text-bone uppercase tracking-widest mb-2">Agreements</Text>
            <Text className="text-ash text-14 mb-8">Review our terms before committing your strategy.</Text>
            
            <View className="gap-6">
              <Pressable onPress={() => setTermsAgreed(!termsAgreed)} className="flex-row items-start gap-4">
                <View className={cx("mt-1 w-5 h-5 border items-center justify-center", termsAgreed ? "border-signal bg-signal/10" : "border-hairline bg-void/50")}>
                  {termsAgreed && <Text className="text-signal text-12 font-mono">✓</Text>}
                </View>
                <Text className="flex-1 text-14 text-bone leading-5">
                  I agree to the <Text className="text-signal">Terms of Service</Text> and acknowledge that Kanon enforcing my rules does not guarantee profit.
                </Text>
              </Pressable>

              <Pressable onPress={() => setPrivacyAgreed(!privacyAgreed)} className="flex-row items-start gap-4">
                <View className={cx("mt-1 w-5 h-5 border items-center justify-center", privacyAgreed ? "border-signal bg-signal/10" : "border-hairline bg-void/50")}>
                  {privacyAgreed && <Text className="text-signal text-12 font-mono">✓</Text>}
                </View>
                <Text className="flex-1 text-14 text-bone leading-5">
                  I agree to the <Text className="text-signal">Privacy Policy</Text> and consent to on-chain pinning of my anonymised rules.
                </Text>
              </Pressable>
              
              <View className="pt-6">
                <PrimaryButton onPress={onClose} disabled={!termsAgreed || !privacyAgreed}>
                  Create Account
                </PrimaryButton>
              </View>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}
