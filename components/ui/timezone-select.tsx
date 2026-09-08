'use client';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface TimezoneSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
}

const TIMEZONES = [
  {
    label: 'North America',
    zones: [
      { value: 'America/New_York', label: 'Eastern Time (ET)' },
      { value: 'America/Chicago', label: 'Central Time (CT)' },
      { value: 'America/Denver', label: 'Mountain Time (MT)' },
      { value: 'America/Phoenix', label: 'Arizona Time (MST)' },
      { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
      { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
      { value: 'Pacific/Honolulu', label: 'Hawaii Time (HST)' },
      { value: 'America/Toronto', label: 'Toronto' },
      { value: 'America/Vancouver', label: 'Vancouver' },
    ],
  },
  {
    label: 'Europe',
    zones: [
      { value: 'Europe/London', label: 'London (GMT/BST)' },
      { value: 'Europe/Paris', label: 'Paris (CET/CEST)' },
      { value: 'Europe/Berlin', label: 'Berlin (CET/CEST)' },
      { value: 'Europe/Rome', label: 'Rome (CET/CEST)' },
      { value: 'Europe/Madrid', label: 'Madrid (CET/CEST)' },
      { value: 'Europe/Amsterdam', label: 'Amsterdam (CET/CEST)' },
      { value: 'Europe/Brussels', label: 'Brussels (CET/CEST)' },
      { value: 'Europe/Stockholm', label: 'Stockholm (CET/CEST)' },
      { value: 'Europe/Warsaw', label: 'Warsaw (CET/CEST)' },
      { value: 'Europe/Athens', label: 'Athens (EET/EEST)' },
      { value: 'Europe/Moscow', label: 'Moscow (MSK)' },
    ],
  },
  {
    label: 'Asia',
    zones: [
      { value: 'Asia/Dubai', label: 'Dubai (GST)' },
      { value: 'Asia/Kolkata', label: 'India (IST)' },
      { value: 'Asia/Shanghai', label: 'China (CST)' },
      { value: 'Asia/Hong_Kong', label: 'Hong Kong (HKT)' },
      { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
      { value: 'Asia/Seoul', label: 'Seoul (KST)' },
      { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
      { value: 'Asia/Bangkok', label: 'Bangkok (ICT)' },
      { value: 'Asia/Jakarta', label: 'Jakarta (WIB)' },
    ],
  },
  {
    label: 'Australia & Pacific',
    zones: [
      { value: 'Australia/Sydney', label: 'Sydney (AEDT/AEST)' },
      { value: 'Australia/Melbourne', label: 'Melbourne (AEDT/AEST)' },
      { value: 'Australia/Brisbane', label: 'Brisbane (AEST)' },
      { value: 'Australia/Perth', label: 'Perth (AWST)' },
      { value: 'Pacific/Auckland', label: 'Auckland (NZDT/NZST)' },
    ],
  },
  {
    label: 'South America',
    zones: [
      { value: 'America/Sao_Paulo', label: 'São Paulo (BRT)' },
      { value: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires (ART)' },
      { value: 'America/Santiago', label: 'Santiago (CLT)' },
      { value: 'America/Bogota', label: 'Bogotá (COT)' },
      { value: 'America/Lima', label: 'Lima (PET)' },
    ],
  },
  {
    label: 'Africa & Middle East',
    zones: [
      { value: 'Africa/Cairo', label: 'Cairo (EET)' },
      { value: 'Africa/Johannesburg', label: 'Johannesburg (SAST)' },
      { value: 'Africa/Lagos', label: 'Lagos (WAT)' },
      { value: 'Africa/Nairobi', label: 'Nairobi (EAT)' },
      { value: 'Asia/Jerusalem', label: 'Jerusalem (IST)' },
    ],
  },
  {
    label: 'Other',
    zones: [{ value: 'UTC', label: 'UTC (Coordinated Universal Time)' }],
  },
];

/** IANA zones this select can render. A value outside this set has no matching
 *  item, so the trigger shows blank -- callers should fall back to 'UTC'. */
export const SUPPORTED_TIMEZONES = new Set<string>(
  TIMEZONES.flatMap((group) => group.zones.map((zone) => zone.value))
);

export function TimezoneSelect({ value, onValueChange, disabled, id }: TimezoneSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Select timezone" />
      </SelectTrigger>
      <SelectContent>
        {TIMEZONES.map((group) => (
          <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.zones.map((zone) => (
              <SelectItem key={zone.value} value={zone.value}>
                {zone.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
