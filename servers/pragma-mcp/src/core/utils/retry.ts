// Retry Utility
// Shared retry logic with exponential backoff for transient API failures
// Copyright (c) 2026 s0nderlabs

// MARK: - Types

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 2) */
  maxRetries?: number;
  /** Base delay in milliseconds (default: 500) */
  baseDelayMs?: number;
  /** Whether to use exponential backoff (default: true) */
  exponentialBackoff?: boolean;
  /** Optional operation name for logging */
  operationName?: string;
  /** Custom transient error checker */
  isTransient?: (error: Error) => boolean;
}

export interface RetryResult<T> {
  /** The successful result, if any */
  data?: T;
  /** The last error encountered, if failed */
  error?: Error;
  /** Number of retries attempted */
  retryCount: number;
  /** Whether the operation ultimately succeeded */
  success: boolean;
}

// MARK: - Constants

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;

/**
 * Patterns indicating transient network errors that should be retried
 * These are case-insensitive substring matches against error messages
 */
const TRANSIENT_ERROR_PATTERNS = [
  // Network-level errors
  "fetch failed",
  "timeout",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "socket hang up",
  "network",
  // HTTP status codes indicating temporary issues
  "502",
  "503",
  "504",
  "429",
  // Rate limiting
  "rate limit",
  "too many requests",
] as const;

// MARK: - Helpers

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default check for transient errors that should be retried
 *
 * Checks if the error message contains any known transient error patterns.
 * This includes network failures, timeouts, and temporary server errors.
 *
 * @param error - The error to check
 * @returns True if the error appears to be transient and retryable
 */
export function isTransientError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((pattern) =>
    message.includes(pattern.toLowerCase())
  );
}

/**
 * Calculate delay for a given attempt using exponential backoff
 *
 * @param attempt - Zero-based attempt number (0 = first retry after initial failure)
 * @param baseDelayMs - Base delay in milliseconds
 * @param exponential - Whether to use exponential backoff
 * @returns Delay in milliseconds
 */
function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  exponential: boolean
): number {
  if (!exponential) return baseDelayMs;
  return baseDelayMs * Math.pow(2, attempt);
}

// MARK: - Main Retry Functions

/**
 * Execute an async operation with retry logic
 *
 * Retries the operation on transient errors with exponential backoff.
 * Returns a result object indicating success/failure and retry count.
 *
 * @param operation - The async function to execute
 * @param options - Retry configuration options
 * @returns RetryResult with data or error
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   async () => {
 *     const response = await fetch(url);
 *     if (!response.ok) throw new Error(`HTTP ${response.status}`);
 *     return response.json();
 *   },
 *   { operationName: "fetch-data", maxRetries: 3 }
 * );
 *
 * if (result.success) {
 *   console.log(result.data);
 * } else {
 *   console.error(result.error);
 * }
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    exponentialBackoff = true,
    operationName = "operation",
    isTransient = isTransientError,
  } = options;

  let lastError: Error | undefined;
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const data = await operation();
      return { data, success: true, retryCount };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      if (attempt < maxRetries && isTransient(lastError)) {
        retryCount++;
        const delay = calculateDelay(attempt, baseDelayMs, exponentialBackoff);
        console.log(
          `[retry] ${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}. Retrying in ${delay}ms...`
        );
        await sleep(delay);
        continue;
      }

      // Non-transient error or max retries reached
      break;
    }
  }

  return { error: lastError, success: false, retryCount };
}

/**
 * Execute an async operation with retry, throwing on failure
 *
 * Convenience wrapper that throws the last error if all retries fail.
 * Use this when you want exception-based error handling.
 *
 * @param operation - The async function to execute
 * @param options - Retry configuration options
 * @returns The result data
 * @throws The last error if all retries fail
 *
 * @example
 * ```typescript
 * try {
 *   const data = await withRetryOrThrow(
 *     async () => fetchQuoteFromAPI(params),
 *     { operationName: "quote-fetch" }
 *   );
 *   return data;
 * } catch (error) {
 *   // All retries exhausted
 *   throw new Error(`Quote failed: ${error.message}`);
 * }
 * ```
 */
export async function withRetryOrThrow<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const result = await withRetry(operation, options);

  if (result.success && result.data !== undefined) {
    return result.data;
  }

  throw (
    result.error ??
    new Error(
      `${options.operationName ?? "Operation"} failed after ${result.retryCount} retries`
    )
  );
}
