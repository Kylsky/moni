export const websiteConfig = {
  name: 'Moni',
  description: 'Your private AI-assisted ledger.',
  url: null as string | null,
  repository: 'https://github.com/ISheepp/Moni',
  defaultTheme: 'system' as const,
  themeStorageKey: 'moni-theme',
  colors: {
    background: '#fff8e8',
    theme: '#ffd84a',
  },
  manifest: {
    id: '/',
    startUrl: '/',
    scope: '/',
  },
  navigation: [
    { id: 'stack', labelKey: 'nav_stack' },
    { id: 'structure', labelKey: 'nav_structure' },
    { id: 'faq', labelKey: 'nav_faq' },
  ],
};
