import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { MoniApp } from '@/components/moni-app';
import { reportOptions } from '@/components/report-workspace';
import { entryFilters } from '@/ledger/entry-query';

export const Route = createFileRoute('/')({
  validateSearch: z.object({
    view: z.enum(['chat', 'entries', 'reports', 'settings']).catch('chat'),
    entry: z
      .union([z.literal('new'), z.uuid()])
      .optional()
      .catch(undefined),
    thread: z.uuid().optional().catch(undefined),
    edit: z.boolean().optional().catch(undefined),
    panel: z
      .enum(['taxonomy', 'trash', 'conversations', 'backup'])
      .optional()
      .catch(undefined),
    filters: entryFilters.optional().catch(undefined),
    report: reportOptions.optional().catch(undefined),
  }),
  head: () => ({
    meta: [{ title: 'Moni' }, { name: 'robots', content: 'noindex, nofollow' }],
  }),
  component: () => {
    const search = Route.useSearch();
    return (
      <MoniApp
        view={search.view}
        entryId={search.entry}
        editing={search.edit}
        panel={search.panel}
        filters={search.filters}
        report={search.report}
        threadId={search.thread}
      />
    );
  },
});
