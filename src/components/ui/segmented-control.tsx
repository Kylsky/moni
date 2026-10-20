import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';

export function SegmentedControl<Value extends string>({
  label,
  items,
  value,
  onValueChange,
}: {
  label: string;
  items: { value: Value; label: string }[];
  value: Value;
  onValueChange: (value: Value) => void;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        if (next[0]) onValueChange(next[0]);
      }}
      className="flex w-fit max-w-full gap-1 rounded-xl bg-muted/65 p-1"
    >
      {items.map((item) => (
        <Toggle
          key={item.value}
          value={item.value}
          className="min-h-9 min-w-11 rounded-lg px-3 py-1.5 text-sm font-bold text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-4 focus-visible:ring-focus data-[pressed]:bg-surface data-[pressed]:text-foreground data-[pressed]:shadow-sm"
        >
          {item.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
