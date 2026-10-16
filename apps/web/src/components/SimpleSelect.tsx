import { Label, ListBox, Select } from "@heroui/react";

export interface Option {
  id: string;
  label: string;
}

interface Props {
  label: string;
  /** Hide the visible label; it stays as the accessible name. */
  hideLabel?: boolean;
  value: string;
  options: Option[];
  onChange: (id: string) => void;
  className?: string;
  isDisabled?: boolean;
}

/** HeroUI Select with a flat option list (value is the option id). */
export function SimpleSelect({ label, hideLabel, value, options, onChange, className, isDisabled }: Props) {
  return (
    <Select
      aria-label={hideLabel ? label : undefined}
      value={value}
      onChange={(key) => key !== null && onChange(String(key))}
      isDisabled={isDisabled}
      className={`min-w-0 ${className ?? ""}`}
    >
      {!hideLabel && <Label>{label}</Label>}
      <Select.Trigger className="min-h-11 items-center">
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((o) => (
            <ListBox.Item key={o.id} id={o.id} textValue={o.label}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
