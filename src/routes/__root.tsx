import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useLocation,
} from '@tanstack/react-router';
import { useEffect } from 'react';
import { websiteConfig } from '@/config/website';
import { type AppLocale, localeMeta, message } from '@/lib/locale';
import { applyTheme } from '@/lib/theme';
import appCss from '@/styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      { name: 'theme-color', content: websiteConfig.colors.theme },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'apple-touch-icon', href: '/icons/icon-192.png' },
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
  notFoundComponent: NotFound,
});

function currentLocale(pathname: string): AppLocale {
  return pathname === '/zh' || pathname.startsWith('/zh/') ? 'zh' : 'en';
}

function RootLayout() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      if (document.documentElement.dataset.theme === 'system')
        applyTheme('system');
    };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return <Outlet />;
}

function NotFound() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const locale = currentLocale(pathname);
  return (
    <>
      <title>{message('not_found_meta_title', locale)}</title>
      <meta
        name="description"
        content={message('not_found_description', locale)}
      />
      <meta name="robots" content="noindex, nofollow" />
      <main
        id="main-content"
        className="mx-auto flex min-h-[68vh] max-w-3xl flex-col items-start justify-center px-6 py-20"
      >
        <span className="rounded-full border-2 border-ink bg-orange px-4 py-1 font-black text-ink">
          404
        </span>
        <h1 className="mt-6 text-5xl font-black tracking-[-0.03em]">
          {message('not_found_title', locale)}
        </h1>
        <p className="mt-4 text-lg text-muted-foreground">
          {message('not_found_description', locale)}
        </p>
        <a
          className="mt-8 rounded-lg border-2 border-ink bg-yellow px-5 py-3 font-black text-ink shadow-brutal"
          href={locale === 'zh' ? '/zh' : '/'}
        >
          {message('not_found_action', locale)}
        </a>
      </main>
    </>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const locale = currentLocale(pathname);
  const themeScript = `(()=>{try{const t=localStorage.getItem(${JSON.stringify(websiteConfig.themeStorageKey)})||${JSON.stringify(websiteConfig.defaultTheme)};const d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=d?'dark':'light'}catch{}})()`;
  return (
    <html lang={localeMeta[locale].hreflang} suppressHydrationWarning>
      <head>
        <script>{themeScript}</script>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
