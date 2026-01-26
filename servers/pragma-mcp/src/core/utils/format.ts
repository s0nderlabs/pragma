// Formatting Utilities
// Copyright (c) 2026 s0nderlabs

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
