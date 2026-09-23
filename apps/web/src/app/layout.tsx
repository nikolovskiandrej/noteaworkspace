import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// Self-hosted from node_modules: no request to a font CDN at build or run time.
import '@fontsource-variable/ibm-plex-sans/wght.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/400-italic.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './globals.css';
import { MotionProvider } from '@/components/motion-provider';

export const metadata: Metadata = {
  title: 'Notea Workspace',
  description: 'Shared remote development workspace for people and AI coding agents',
};

export const viewport: Viewport = {
  themeColor: '#090b0a',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full">
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
