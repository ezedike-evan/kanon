import React from 'react';
import { AppHeader } from '../../src/components/app-header';
import { ClientOnly } from '../../src/components/client-only';

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col min-h-screen bg-canvas">
      <ClientOnly>
        <AppHeader />
      </ClientOnly>
      <main className="flex-1 overflow-hidden relative">
        {children}
      </main>
    </div>
  );
}
