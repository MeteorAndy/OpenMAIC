import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import 'animate.css';
import 'katex/dist/katex.min.css';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import { Toaster } from '@/components/ui/sonner';
import { ServerProvidersInit } from '@/components/server-providers-init';
import { StorageHealthNotice } from '@/components/storage-health-notice';
import { AccessCodeGuard } from '@/components/access-code-guard';
import { WorkspaceCompatibilityGuard } from '@/components/workspace-compatibility-guard';

const inter = localFont({
  src: '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  variable: '--font-sans',
  weight: '100 900',
});

export const metadata: Metadata = {
  title: 'OpenMAIC Desktop',
  description:
    'The open-source AI interactive classroom. Upload a PDF to instantly generate an immersive, multi-agent learning experience.',
};

// WebView2 (Tauri) needs an explicit viewport meta to track window resizes —
// without it the layout viewport stays fixed and content doesn't reflow when
// the window is resized.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Generated local font aliases cannot be imported through Next's CSS pipeline. */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/vendor/desktop-fonts/fonts.css" />
      </head>
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        <ThemeProvider>
          <I18nProvider>
            <WorkspaceCompatibilityGuard>
              <ServerProvidersInit />
              <AccessCodeGuard>{children}</AccessCodeGuard>
              <Toaster position="top-center" />
              {/* After the Toaster: this one raises a toast on mount when
                  persistence is already broken, and a toast raised before its
                  host exists has nowhere to go. */}
              <StorageHealthNotice />
            </WorkspaceCompatibilityGuard>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
