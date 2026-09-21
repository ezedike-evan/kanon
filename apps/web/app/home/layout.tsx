import React from 'react';

/**
 * Home is a tab like Chart, Predict and Profile: the screen brings its own status bar and tab
 * bar, so nothing sits above it. It used to carry the marketing header (`AppHeader`, a fixed bar
 * with "Launch App"), which covered the greeting; account and sign-out live in Profile.
 */
export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
