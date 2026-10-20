import { NumberField } from '@base-ui/react/number-field';
import { Popover } from '@base-ui/react/popover';
import {
  IconCalendarMonth,
  IconChevronLeft,
  IconChevronRight,
} from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { type AppLocale, message } from '@/lib/locale';

export function ReportMonthPicker({
  value,
  onChange,
  locale,
}: {
  value: string;
  onChange: (value: string) => void;
  locale: AppLocale;
}) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState<number | null>(Number(value.slice(0, 4)));
  const popup = useRef<HTMLDivElement>(null);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const date = new Date(`${value}-01T00:00:00Z`);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setYear(Number(value.slice(0, 4)));
        setOpen(next);
      }}
    >
      <Popover.Trigger
        render={
          <Button
            variant="plain"
            className="min-w-36 flex-1 border-0! px-3! shadow-none!"
          />
        }
        aria-label={t('report_month')}
      >
        <IconCalendarMonth size={19} aria-hidden />
        {new Intl.DateTimeFormat(locale, {
          year: 'numeric',
          month: 'long',
          timeZone: 'UTC',
        }).format(date)}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} className="z-[100] outline-none">
          <Popover.Popup
            ref={popup}
            initialFocus={() =>
              popup.current?.querySelector<HTMLElement>(
                'button[aria-pressed="true"]'
              ) ?? true
            }
            className="w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-foreground/20 bg-surface p-4 text-foreground shadow-lg outline-none"
          >
            <Popover.Title className="sr-only">
              {t('report_month')}
            </Popover.Title>
            <NumberField.Root
              value={year}
              onValueChange={setYear}
              min={1900}
              max={9999}
              step={1}
              smallStep={1}
              format={{ useGrouping: false }}
            >
              <NumberField.Group className="mb-4 flex items-center gap-2">
                <NumberField.Decrement
                  render={<Button variant="icon" className="border-0!" />}
                  aria-label={t('report_previous_year')}
                >
                  <IconChevronLeft size={18} aria-hidden />
                </NumberField.Decrement>
                <NumberField.Input
                  aria-label={t('report_year')}
                  className="moni-field text-center font-bold"
                />
                <NumberField.Increment
                  render={<Button variant="icon" className="border-0!" />}
                  aria-label={t('report_next_year')}
                >
                  <IconChevronRight size={18} aria-hidden />
                </NumberField.Increment>
              </NumberField.Group>
            </NumberField.Root>
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: 12 }, (_, index) => {
                const month = String(index + 1).padStart(2, '0');
                const active = `${year}-${month}` === value;
                return (
                  <Button
                    key={month}
                    variant="plain"
                    aria-pressed={active}
                    disabled={
                      year === null ||
                      year < 1900 ||
                      year > 9999 ||
                      !Number.isInteger(year)
                    }
                    className={`border-0! px-2! text-sm! shadow-none! ${active ? 'bg-orange/20' : ''}`}
                    onClick={() => {
                      onChange(`${year}-${month}`);
                      setOpen(false);
                    }}
                  >
                    {new Intl.DateTimeFormat(locale, {
                      month: 'short',
                      timeZone: 'UTC',
                    }).format(new Date(Date.UTC(2024, index, 1)))}
                  </Button>
                );
              })}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
