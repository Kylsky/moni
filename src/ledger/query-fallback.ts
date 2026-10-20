import { type AppLocale, message } from '../lib/locale';
import { wechatStatistics } from '../lib/wechat-format';
import { refreshLedgerQuery } from './chat-query';
import type { LedgerQueryResult } from './chat-query-contract';

export async function lastQueryDetails(
  db: D1Database,
  datasetId: string,
  previous: LedgerQueryResult | null,
  locale: AppLocale
) {
  if (!previous) return null;
  // No intent is inferred on failure: refresh only the saved, explicitly displayed criteria.
  const result = await refreshLedgerQuery(db, datasetId, {
    ...previous,
    id: crypto.randomUUID(),
    query: { ...previous.query, view: 'entries', page: 1 },
  });
  return `${message('chat_query_fallback', locale)}\n\n${wechatStatistics(result, locale)}`;
}
