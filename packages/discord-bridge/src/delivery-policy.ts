export const GAMEPLAY_DELIVERY_RETRIES = 3;
export const GAMEPLAY_DELIVERY_BACKOFF_MS = 250;
export const MAX_GAMEPLAY_DELIVERY_BACKOFF_MS = 5_000;
export const MAX_CONSECUTIVE_DELIVERY_FAILURES = 3;

export function gameplayDeliveryBackoffMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(GAMEPLAY_DELIVERY_BACKOFF_MS * attempt, MAX_GAMEPLAY_DELIVERY_BACKOFF_MS);
}

export function nextDeliveryFailure(currentFailures: number | undefined): {
  failures: number;
  shouldTerminate: boolean;
} {
  const failures = (currentFailures ?? 0) + 1;
  return {
    failures,
    shouldTerminate: failures >= MAX_CONSECUTIVE_DELIVERY_FAILURES,
  };
}