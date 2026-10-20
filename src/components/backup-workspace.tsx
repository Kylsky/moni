import { IconArrowLeft } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { DownloadButton } from '@/components/download-button';
import { RestorePreparation } from '@/components/restore-preparation';
import { buttonVariants } from '@/components/ui/button';
import { type AppLocale, message } from '@/lib/locale';

export function BackupWorkspace({
  datasetId,
  locale,
}: {
  datasetId: string;
  locale: AppLocale;
}) {
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  return (
    <>
      <Link
        to="/"
        search={{ view: 'settings' }}
        className="mb-6 inline-flex min-h-11 items-center gap-2 rounded-lg font-bold focus-visible:outline-4 focus-visible:outline-focus"
      >
        <IconArrowLeft size={20} aria-hidden />
        {t('app_settings')}
      </Link>
      <h1 className="text-3xl font-extrabold">{t('backup_title')}</h1>
      <p className="mb-7 mt-3 text-muted-foreground">
        {t('backup_description')}
      </p>
      <div className="space-y-5">
        <section
          aria-labelledby="csv-heading"
          className="rounded-2xl border-2 border-foreground bg-surface p-5 md:flex md:items-center md:justify-between md:gap-8 md:p-7"
        >
          <div className="mb-5 md:mb-0">
            <h2 id="csv-heading" className="text-xl font-extrabold">
              1. {t('export_csv_title')}
            </h2>
            <p className="mt-3 max-w-xl text-muted-foreground">
              {t('export_csv_description')}
            </p>
          </div>
          <Link
            to="/"
            search={{ view: 'entries' }}
            className={buttonVariants()}
          >
            {t('export_choose_filters')}
          </Link>
        </section>
        <section
          aria-labelledby="backup-heading"
          className="rounded-2xl border-2 border-foreground bg-surface p-5 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-8 md:p-7"
        >
          <div className="flex items-start gap-4">
            <img
              src="/moni/illustrations/assistant-backup.png"
              alt=""
              className="w-20 shrink-0 md:w-28"
            />
            <div>
              <h2 id="backup-heading" className="text-xl font-extrabold">
                2. {t('backup_json_title')}
              </h2>
              <p className="mt-3 text-muted-foreground">
                {t('backup_json_description')}
              </p>
            </div>
          </div>
          <div className="mt-5 md:mt-0">
            <div className="mb-3 rounded-xl bg-muted p-4">
              <h3 className="font-bold">{t('backup_includes')}</h3>
              <p className="mt-2 text-sm">{t('backup_contents')}</p>
            </div>
            <div className="mb-4 rounded-xl bg-muted p-4">
              <h3 className="font-bold">{t('backup_excludes')}</h3>
              <p className="mt-2 text-sm">{t('backup_private')}</p>
            </div>
            <DownloadButton
              path={`exports/backup?datasetId=${encodeURIComponent(datasetId)}`}
              datasetId={datasetId}
              filename="moni-backup.json"
              label={t('backup_download')}
              locale={locale}
            />
          </div>
        </section>
        <RestorePreparation datasetId={datasetId} locale={locale} />
      </div>
    </>
  );
}
