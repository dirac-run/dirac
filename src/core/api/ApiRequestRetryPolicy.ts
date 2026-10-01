/** Automatic request retries shared by the task loop and independent Utility requests. */
export const MAX_API_REQUEST_RETRIES = 3

/** retryAttempt is one-based: the normal retry delays are 2s, 4s, and 8s. */
export function getApiRequestRetryDelay(retryAttempt: number): number {
	return 2000 * 2 ** (retryAttempt - 1)
}
