// Formatting Utilities
// Copyright (c) 2026 s0nderlabs

/**
 * Format a Date as ISO-like string with local timezone offset
 * @param date - Date to format
 * @returns String like "2026-01-28T14:30:00+07:00"
 */
export function formatLocalTimestamp(date: Date): string {
  const tzOffset = -date.getTimezoneOffset();
  const sign = tzOffset >= 0 ? "+" : "-";
  const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, "0");

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(tzOffset / 60)}:${pad(tzOffset % 60)}`
  );
}

/**
 * Format time remaining until a given timestamp
 * @param expiresAt - Expiry timestamp in milliseconds
 * @returns Human-readable string like "3d 5h", "2h", "45m", or "Expired"
 */
export function formatTimeRemaining(expiresAt: number): string {
  const now = Date.now();
  const remaining = expiresAt - now;

  if (remaining <= 0) {
    return "Expired";
  }

  const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }

  const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
  return `${minutes}m`;
}
