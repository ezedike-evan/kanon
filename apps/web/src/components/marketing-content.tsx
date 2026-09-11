'use client';

import React, { useState } from 'react';
import { SpecularButton, AuthModal } from '@kanon/ui';

const CheckIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const ShieldIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

export function MarketingContent() {
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  return (
    <>
      <AuthModal isOpen={isAuthModalOpen} onClose={() => setIsAuthModalOpen(false)} />
      
      {/* Navbar */}
      <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 bg-void/80 backdrop-blur-md border-b border-hairline">
        <div className="flex items-center gap-3">
          <img src="/icons/icon.svg" className="h-6 w-auto" alt="Kanon Logo" />
          <div className="text-bone font-bold text-xl tracking-widest uppercase">
            Kanon
          </div>
        </div>
        <nav className="hidden md:flex gap-8 text-ash text-sm uppercase tracking-widest">
          <a href="#features" className="hover:text-bone transition-colors">Features</a>
          <a href="#thesis" className="hover:text-bone transition-colors">Thesis</a>
        </nav>
        <SpecularButton onClick={() => setIsAuthModalOpen(true)} size="sm" className="uppercase tracking-widest font-bold text-xs" tint="#D4A017" tintOpacity={0.2} lineColor="#D4A017">
          Launch App
        </SpecularButton>
      </header>

      {/* Hero Section */}
      <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 text-center pt-20">
        <div className="absolute inset-0 bg-gradient-to-b from-panel via-void to-void" />
        <div className="relative z-10 max-w-4xl mt-12">
          <div className="mb-6 inline-flex items-center gap-2 rounded-none border border-hairline bg-panel px-4 py-1.5 text-xs text-ash uppercase tracking-widest">
            <span className="h-1.5 w-1.5 rounded-none bg-signal" />
            Now in Private Beta
          </div>
          
          <h1 className="mb-6 text-4xl font-bold tracking-tight text-bone md:text-6xl uppercase">
            The rule outranks <br />
            <span className="text-signal">the chart.</span>
          </h1>
          
          <p className="mx-auto mb-10 max-w-2xl text-lg text-ash leading-relaxed">
            Your trading strategy, compiled into a contract that refuses trades breaking your own rules — including the ones you would have broken yourself.
          </p>
          
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:justify-center">
            <SpecularButton onClick={() => setIsAuthModalOpen(true)} size="lg" className="uppercase tracking-widest font-bold text-sm" tint="#D4A017" tintOpacity={0.15} lineColor="#D4A017">
              Compile Strategy
            </SpecularButton>
            <a href="#thesis">
              <button className="border border-hairline text-bone hover:bg-panel px-8 py-[18px] uppercase tracking-wider text-sm transition-colors h-[56px]">
                Read the Thesis
              </button>
            </a>
          </div>
        </div>
      </section>

      {/* Problem / Agitate / Solution */}
      <section id="thesis" className="py-24 px-6 border-t border-hairline bg-void">
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-12">
          <div className="p-8 border border-hairline bg-panel relative overflow-hidden">
             <div className="absolute top-0 left-0 w-1 h-full bg-short" />
             <h3 className="text-xl font-bold text-bone mb-4 uppercase">The Problem</h3>
             <p className="text-ash leading-relaxed text-sm">
               You have an edge, but you bleed it. You widen stops. You revenge trade. You take setups before the candle closes because the FOMO hits. 
             </p>
          </div>
          <div className="p-8 border border-hairline bg-panel relative overflow-hidden">
             <div className="absolute top-0 left-0 w-1 h-full bg-refused" />
             <h3 className="text-xl font-bold text-bone mb-4 uppercase">The Reality</h3>
             <p className="text-ash leading-relaxed text-sm">
               Every AI agent asks you to trust the model. But you are your own worst enemy. Your discipline fails when you need it most, and nobody enforces your rules.
             </p>
          </div>
          <div className="p-8 border border-hairline bg-panel relative overflow-hidden">
             <div className="absolute top-0 left-0 w-1 h-full bg-long" />
             <h3 className="text-xl font-bold text-bone mb-4 uppercase">The Solution</h3>
             <p className="text-ash leading-relaxed text-sm">
               Kanon inverts it. The model proposes, and a contract that cannot think checks the proposal against a rule you pinned when you were calm.
             </p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-32 px-6 bg-panel border-t border-hairline">
        <div className="max-w-6xl mx-auto space-y-32">
          
          {/* Compilation */}
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div>
              <div className="mb-4 inline-flex items-center gap-2 text-sm text-signal uppercase tracking-widest">
                01 — Compilation
              </div>
              <h2 className="text-3xl font-bold text-bone mb-6 uppercase">From language to <br/>executable spec</h2>
              <p className="text-ash text-lg mb-6 leading-relaxed">
                You describe a strategy in your own words. Smart Money Concepts, formalised. A fair value gap is arithmetic on three candles. A liquidity sweep is a wick beyond a prior extreme.
              </p>
              <ul className="space-y-3 text-bone text-sm">
                <li className="flex gap-3 items-center"><CheckIcon className="w-5 h-5 text-long" /> Speak SMC natively. No tooltips.</li>
                <li className="flex gap-3 items-center"><CheckIcon className="w-5 h-5 text-long" /> Force parameters into the open.</li>
                <li className="flex gap-3 items-center"><CheckIcon className="w-5 h-5 text-long" /> Argue with the compiler and tune it.</li>
              </ul>
            </div>
            <div className="aspect-square bg-void border border-hairline p-8 flex items-center justify-center relative overflow-hidden">
              <div className="font-mono text-xs text-ash opacity-50 absolute top-4 left-4 uppercase tracking-widest">SPEC.TS</div>
              <div className="text-bone space-y-4 w-full text-sm">
                <div className="flex justify-between border-b border-hairline pb-2"><span>fair_value_gap</span> <span className="text-signal">true</span></div>
                <div className="flex justify-between border-b border-hairline pb-2"><span>liquidity_sweep</span> <span className="text-signal">gt 12</span></div>
                <div className="flex justify-between border-b border-hairline pb-2"><span>order_block</span> <span className="text-signal">confirmed</span></div>
              </div>
            </div>
          </div>

          {/* Refusal */}
          <div className="grid md:grid-cols-2 gap-16 items-center lg:flex-row-reverse">
            <div className="order-1 md:order-2">
              <div className="mb-4 inline-flex items-center gap-2 text-sm text-refused uppercase tracking-widest">
                02 — Refusal
              </div>
              <h2 className="text-3xl font-bold text-bone mb-6 uppercase">The hero moment: <br/>Being stopped</h2>
              <p className="text-ash text-lg mb-6 leading-relaxed">
                A setup does not satisfy the spec. The contract blocks it and names the predicate and the number that failed. You are protected from the market, and from yourself.
              </p>
              <ul className="space-y-3 text-bone text-sm">
                <li className="flex gap-3 items-center"><CheckIcon className="w-5 h-5 text-refused" /> Hard rejection on rule break.</li>
                <li className="flex gap-3 items-center"><CheckIcon className="w-5 h-5 text-refused" /> Adherence is the primary metric.</li>
                <li className="flex gap-3 items-center"><CheckIcon className="w-5 h-5 text-refused" /> See how many blocked trades would have lost.</li>
              </ul>
            </div>
            <div className="order-2 md:order-1 aspect-square bg-[#E8462E]/10 border border-refused p-8 flex flex-col items-center justify-center relative">
              <div className="text-refused text-5xl font-bold mb-4 uppercase tracking-tighter">BLOCK</div>
              <div className="text-bone text-xs border border-refused px-4 py-2 bg-void tracking-widest uppercase">PREDICATE FAILED: FVG NOT TOUCHED</div>
            </div>
          </div>

          {/* Evidence */}
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div>
              <div className="mb-4 inline-flex items-center gap-2 text-sm text-verified uppercase tracking-widest">
                03 — Evidence
              </div>
              <h2 className="text-3xl font-bold text-bone mb-6 uppercase">Verifiable strategies, <br/>provable history</h2>
              <p className="text-ash text-lg mb-6 leading-relaxed">
                Any trade, taken or blocked, is one tap from the timestamps and price attestations that decided it. If verification takes more than one tap, it is just marketing.
              </p>
              <ul className="space-y-3 text-bone text-sm">
                <li className="flex gap-3 items-center"><CheckIcon className="w-5 h-5 text-verified" /> Pinned on-chain with a bond.</li>
                <li className="flex gap-3 items-center"><CheckIcon className="w-5 h-5 text-verified" /> One tap from trade to evidence.</li>
                <li className="flex gap-3 items-center"><CheckIcon className="w-5 h-5 text-verified" /> Shareable strategy cards.</li>
              </ul>
            </div>
            <div className="aspect-square bg-void border border-hairline p-8 flex flex-col items-center justify-center">
               <ShieldIcon className="w-16 h-16 text-verified mb-8" />
               <div className="text-bone text-center text-sm tracking-widest uppercase">
                 0x8f2a...391c
               </div>
               <div className="text-ash text-xs mt-2 text-center uppercase tracking-widest">
                 ATTESTATION VERIFIED
               </div>
            </div>
          </div>

        </div>
      </section>

      {/* CTA Section */}
      <section className="py-32 px-6 border-t border-hairline bg-void text-center">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-4xl font-bold text-bone mb-6 uppercase">Take nobody&apos;s word for it. <br/>Not even your AI&apos;s.</h2>
          <p className="text-ash text-lg mb-10 leading-relaxed">
            Commit your strategy. Post your bond. Prove your track record.
          </p>
          <SpecularButton onClick={() => setIsAuthModalOpen(true)} size="lg" className="uppercase tracking-widest font-bold text-sm" tint="#D4A017" tintOpacity={0.15} lineColor="#D4A017">
            Join the Beta
          </SpecularButton>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-6 border-t border-hairline bg-panel text-center text-xs text-ash tracking-widest uppercase">
        <p>© {new Date().getFullYear()} Kanon. The rule outranks the chart.</p>
      </footer>
    </>
  );
}
