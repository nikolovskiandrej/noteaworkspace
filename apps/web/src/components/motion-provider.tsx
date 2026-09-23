'use client';

import { LazyMotion, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';

const loadFeatures = () => import('./motion-features').then((mod) => mod.default);

/**
 * App-wide animation settings. Features load lazily (the `m` components render
 * without them and animate once they arrive), and `reducedMotion="user"` turns
 * transforms and layout animation off for anyone who asked their system for less
 * motion; opacity changes stay, so state changes remain visible.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={loadFeatures} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
