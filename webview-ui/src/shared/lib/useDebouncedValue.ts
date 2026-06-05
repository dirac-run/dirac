import { useEffect, useState } from "react"

/**
 * Returns a debounced version of `value` that updates at most once per `delay` ms.
 * When `delay` is 0, the value passes through immediately (no debounce).
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
	const [debounced, setDebounced] = useState(value)

	useEffect(() => {
		if (delay <= 0) {
			setDebounced(value)
			return
		}

		const timer = setTimeout(() => setDebounced(value), delay)
		return () => clearTimeout(timer)
	}, [value, delay])

	return debounced
}
