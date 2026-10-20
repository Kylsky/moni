import { z } from 'zod';
import { assertChanged, commandIdentity, executeCommand } from '../lib/command';
import { HttpError } from '../lib/http';
import { currencies } from './currencies';

const settingValues = {
  primaryCurrency: z.enum(currencies),
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
};
export const initializeInput = z
  .object({ ...commandIdentity, ...settingValues })
  .strict();
export const settingsInput = initializeInput
  .extend({ version: z.number().int().nonnegative() })
  .strict();

export type LedgerSettings = {
  datasetId: string;
  primaryCurrency: (typeof currencies)[number];
  timeZone: string;
  initialized: boolean;
  currencyLocked: boolean;
  version: number;
};

export async function readSettings(db: D1Database): Promise<LedgerSettings> {
  const row = await db
    .prepare(`SELECT d.* FROM datasets d JOIN moni_state s
    ON s.singleton = 1 AND s.active_dataset = d.id`)
    .first<{
      id: string;
      primary_currency: LedgerSettings['primaryCurrency'];
      time_zone: string;
      initialized: number;
      currency_locked: number;
      version: number;
    }>();
  if (!row) throw new HttpError(503, 'storage_not_ready');
  return {
    datasetId: row.id,
    primaryCurrency: row.primary_currency,
    timeZone: row.time_zone,
    initialized: row.initialized === 1,
    currencyLocked: row.currency_locked === 1,
    version: row.version,
  };
}

export async function saveSettings(
  db: D1Database,
  raw: unknown,
  initialize: boolean
) {
  const parsed = (initialize ? initializeInput : settingsInput).safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_settings');
  const input = parsed.data;
  const update = initialize
    ? db
        .prepare(`UPDATE datasets SET primary_currency = ?, time_zone = ?, initialized = 1,
        version = version + 1 WHERE id = ? AND initialized = 0`)
        .bind(input.primaryCurrency, input.timeZone, input.datasetId)
    : db
        .prepare(`UPDATE datasets SET primary_currency = ?, time_zone = ?, version = version + 1
        WHERE id = ? AND initialized = 1 AND version = ?
        AND (currency_locked = 0 OR primary_currency = ?)`)
        .bind(
          input.primaryCurrency,
          input.timeZone,
          input.datasetId,
          'version' in input ? input.version : -1,
          input.primaryCurrency
        );
  return executeCommand(
    db,
    initialize ? 'initialize' : 'settings',
    input,
    [update, assertChanged(db)],
    { saved: true }
  );
}
