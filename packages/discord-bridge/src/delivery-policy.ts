export const GAMEPLAY_DELIVERY_RETRIES = 3;
export const GAMEPLAY_DELIVERY_BACKOFF_MS = 250;
export const MAX_GAMEPLAY_DELIVERY_BACKOFF_MS = 5_000;
export const MAX_CONSECUTIVE_DELIVERY_FAILURES = 3;

export function gameplayDeliveryBackoffMs(
  attempt: number,
  backoffMs: number = GAMEPLAY_DELIVERY_BACKOFF_MS,
  maxBackoffMs: number = MAX_GAMEPLAY_DELIVERY_BACKOFF_MS,
): number {
  if (attempt <= 0) return 0;
  return Math.min(backoffMs * attempt, maxBackoffMs);
}

export function nextDeliveryFailure(
  currentFailures: number | undefined,
  maxConsecutive: number = MAX_CONSECUTIVE_DELIVERY_FAILURES,
): {
  failures: number;
  shouldTerminate: boolean;
} {
  const failures = (currentFailures ?? 0) + 1;
  return {
    failures,
    shouldTerminate: failures >= maxConsecutive,
  };
}
