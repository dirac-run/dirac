import { createContext } from "react"

/** The provider being edited, independently of the running task's provider. */
export const ProviderSetupContext = createContext<string | undefined>(undefined)
