import { createFileRoute } from '@tanstack/react-router';
import { MoniApp } from '@/components/moni-app';

export const Route = createFileRoute('/zh')({
  head: () => ({
    meta: [{ title: 'Moni' }, { name: 'robots', content: 'noindex, nofollow' }],
  }),
  component: () => <MoniApp initialLocale="zh" />,
});
