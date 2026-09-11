import React from 'react';
import type { Metadata } from 'next';
import { MarketingContent } from '../src/components/marketing-content';
import { ClientOnly } from '../src/components/client-only';

export const metadata: Metadata = {
  title: 'Kanon | The Rule Outranks The Chart',
  description: 'Your trading strategy, compiled into a contract that refuses trades breaking your own rules. Protect yourself from the market, and from yourself.',
  openGraph: {
    title: 'Kanon | The Rule Outranks The Chart',
    description: 'Your trading strategy, compiled into a contract that refuses trades breaking your own rules.',
    images: ['/og-image.jpg'],
  }
};

export default function LandingPage() {
  // JSON-LD for Organization / Product
  const schema = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "Kanon",
    "applicationCategory": "FinanceApplication",
    "description": "Your trading strategy, compiled into a contract that refuses trades breaking your own rules.",
    "offers": {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "USD"
    }
  };

  return (
    <div className="min-h-screen bg-void text-bone font-mono">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />
      <ClientOnly>
        <MarketingContent />
      </ClientOnly>
    </div>
  );
}
