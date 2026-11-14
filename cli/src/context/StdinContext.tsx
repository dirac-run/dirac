/**
 * Context for tracking stdin raw mode support
 * Used to conditionally disable input handling when stdin doesn't support raw mode
 * (e.g., when input is piped: echo "..." | diracdev)
 */

import { useStdin } from "ink"
import React, { createContext, type ReactNode, useContext, useEffect } from "react"

interface StdinContextValue {
	/**
	 * Whether stdin supports raw mode (keyboard input handling)
	 * Will be false when input is piped or stdin is not a TTY
	 */
	isRawModeSupported: boolean
}

const StdinContext = createContext<StdinContextValue>({ isRawModeSupported: true })

export const useStdinContext = () => useContext(StdinContext)

interface StdinProviderProps {
	children: ReactNode
	isRawModeSupported: boolean
}

const WindowsSessionRawModeKeeper: React.FC<{ isRawModeSupported: boolean }> = ({ isRawModeSupported }) => {
	const { setRawMode, stdin } = useStdin()

	useEffect(() => {
		if (process.platform !== "win32" || !isRawModeSupported) {
			return
		}

		// Mount before terminal-capability probes: their temporary raw-mode claims
		// must not return Windows stdin to cooked mode between queries or views.
		setRawMode(true)
		if (stdin && typeof stdin.resume === "function") {
			stdin.resume()
		}

		return () => {
			// Leave pause/resume restoration to the outer runInkApp cleanup, which
			// records and restores the original stdin paused state for the session.
			setRawMode(false)
		}
	}, [isRawModeSupported, setRawMode, stdin])

	return null
}

export const StdinProvider: React.FC<StdinProviderProps> = ({ children, isRawModeSupported }) => {
	return (
		<StdinContext.Provider value={{ isRawModeSupported }}>
			<WindowsSessionRawModeKeeper isRawModeSupported={isRawModeSupported} />
			{children}
		</StdinContext.Provider>
	)
}

/**
 * Check if stdin supports raw mode
 * Returns false when input is piped or stdin is not a TTY
 */
export function checkRawModeSupport(): boolean {
	return Boolean(process.stdin.isTTY && typeof process.stdin.setRawMode === "function")
}
