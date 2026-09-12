'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { usePrivy } from '@privy-io/react-auth';
import { useQuery } from 'convex/react';
import { api } from '@kanon/backend';
import { SpecularButton } from '@kanon/ui';

export function AppHeader() {
  const router = useRouter();
  const { authenticated, user, logout } = usePrivy();
  const dbUser = useQuery(api.users.getUserByPrivyId, user ? { privyId: user.id } : "skip");

  return (
    <header className="fixed top-0 left-0 w-full flex justify-between items-center px-6 py-4 border-b border-hairline bg-panel/80 z-50 backdrop-blur-md">
      <div className="flex items-center gap-3">
        <img src="/icons/icon.svg" className="h-6 w-auto" alt="Kanon Logo" />
        <div className="text-bone font-bold text-xl tracking-widest uppercase cursor-pointer" onClick={() => router.push('/')}>
          Kanon
        </div>
      </div>
      
      <div className="flex items-center gap-4">
        {authenticated && dbUser ? (
          <div className="flex items-center gap-4">
            <span className="text-ash text-sm font-mono">@{dbUser.username}</span>
            <SpecularButton onClick={() => logout()} size="sm" className="uppercase tracking-widest font-bold text-xs" tint="#D4A017" tintOpacity={0.1} lineColor="#D4A017">
              Sign Out
            </SpecularButton>
          </div>
        ) : (
          <SpecularButton onClick={() => router.push('/')} size="sm" className="uppercase tracking-widest font-bold text-xs" tint="#D4A017" tintOpacity={0.2} lineColor="#D4A017">
            Launch App
          </SpecularButton>
        )}
      </div>
    </header>
  );
}
