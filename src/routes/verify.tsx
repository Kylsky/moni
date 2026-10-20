import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';
import { z } from 'zod';
import { ProbePage } from '@/components/probe-page';

export const Route = createFileRoute('/verify')({
  validateSearch: z.object({ threadId: z.uuid().optional() }),
  head: () => ({
    meta: [
      { title: 'Moni · Private connection check' },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  component: Verification,
});

function Verification() {
  const { threadId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const newThread = useCallback(() => {
    void navigate({ search: { threadId: crypto.randomUUID() }, replace: true });
  }, [navigate]);
  useEffect(() => {
    if (!threadId) newThread();
  }, [threadId, newThread]);
  return threadId ? <ProbePage threadId={threadId} onNew={newThread} /> : null;
}
