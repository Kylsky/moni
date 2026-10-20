import { Select as BaseSelect } from '@base-ui/react/select';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

export function Select<Value extends string | number>({
  label,
  items,
  value,
  onValueChange,
  className,
}: {
  label: string;
  items: { value: Value; label: string }[];
  value: Value;
  onValueChange: (value: Value) => void;
  className?: string;
}) {
  return (
    <BaseSelect.Root
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
    >
      <BaseSelect.Trigger
        aria-label={label}
        className={cn(
          'flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-foreground/20 bg-surface px-3 py-2 text-left text-sm font-bold outline-none transition-colors hover:border-foreground/50 focus-visible:ring-4 focus-visible:ring-focus data-[popup-open]:border-orange',
          className
        )}
      >
        <BaseSelect.Value className="truncate" />
        <BaseSelect.Icon>
          <IconChevronDown size={18} aria-hidden />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          sideOffset={6}
          align="start"
          alignItemWithTrigger={false}
          className="z-[100] outline-none"
        >
          <BaseSelect.Popup className="max-h-[var(--available-height)] min-w-[var(--anchor-width)] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-foreground/20 bg-surface p-1.5 text-foreground shadow-lg outline-none">
            <BaseSelect.List>
              {items.map((item) => (
                <BaseSelect.Item
                  key={item.value}
                  value={item.value}
                  className="relative flex min-h-11 cursor-pointer items-center rounded-lg py-2 pr-10 pl-3 text-sm font-bold outline-none data-[highlighted]:bg-orange/15"
                >
                  <BaseSelect.ItemText>{item.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="absolute right-3">
                    <IconCheck size={18} aria-hidden />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
