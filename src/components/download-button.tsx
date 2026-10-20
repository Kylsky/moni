import { IconDownload } from '@tabler/icons-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { type AppLocale, message } from '@/lib/locale';
import { cn } from '@/lib/utils';

export function DownloadButton({
  path,
  body,
  datasetId,
  filename,
  label,
  locale,
  primary = false,
  disabled = false,
  onDownloaded,
  className,
}: {
  path: string;
  body?: unknown;
  datasetId: string;
  filename: string;
  label: string;
  locale: AppLocale;
  primary?: boolean;
  disabled?: boolean;
  onDownloaded?: (headers: Headers) => void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<number | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  return (
    <div>
      <Button
        variant={primary ? 'primary' : 'plain'}
        disabled={busy || disabled}
        className={cn('w-full md:w-auto', className)}
        onClick={async () => {
          setBusy(true);
          setFailure(null);
          setDownloaded(false);
          let url: string | undefined;
          try {
            const response = await fetch(
              `/api/${path}`,
              body === undefined
                ? {}
                : {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                  }
            );
            if (!response.ok) {
              setFailure(response.status);
              return;
            }
            if (response.headers.get('X-Moni-Dataset') !== datasetId) {
              setFailure(409);
              return;
            }
            url = URL.createObjectURL(await response.blob());
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            onDownloaded?.(response.headers);
            setDownloaded(true);
          } catch {
            setFailure(500);
          } finally {
            // Keep the blob alive until the browser has accepted the download.
            const downloadUrl = url;
            if (downloadUrl)
              setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
            setBusy(false);
          }
        }}
      >
        <IconDownload size={20} aria-hidden />
        {busy ? t('export_working') : label}
      </Button>
      {failure !== null && (
        <p role="alert" className="mt-3 max-w-xl">
          {t(
            failure === 413
              ? 'export_too_large'
              : failure === 409
                ? 'export_changed'
                : 'export_failed'
          )}
        </p>
      )}
      {downloaded && (
        <output className="mt-3 block text-sm text-muted-foreground">
          {t('export_downloaded')}
        </output>
      )}
    </div>
  );
}
