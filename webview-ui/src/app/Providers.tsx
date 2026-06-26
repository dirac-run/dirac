import { HeroUIProvider } from "@heroui/react"
import { TooltipProvider } from "@/shared/ui/tooltip"
import { type ReactNode } from "react"
import { DiracAuthProvider } from "@/context/DiracAuthContext"
import { PlatformProvider } from "@/context/PlatformContext"
export function Providers({ children }: { children: ReactNode }) {
	return (
		<PlatformProvider>
			<DiracAuthProvider>
				<HeroUIProvider>
					<TooltipProvider>{children}</TooltipProvider>
				</HeroUIProvider>
			</DiracAuthProvider>
		</PlatformProvider>
	)
}
