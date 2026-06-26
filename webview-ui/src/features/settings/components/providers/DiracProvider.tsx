import { Mode } from "@shared/ExtensionMessage"
import { DiracAccountInfoCard } from "../DiracAccountInfoCard"
import DiracModelPicker from "../DiracModelPicker"

/**
 * Props for the DiracProvider component
 */
interface DiracProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The Dirac provider configuration component
 */
export const DiracProvider = ({ showModelOptions, isPopup, currentMode }: DiracProviderProps) => {
	return (
		<div>
			{/* Dirac Account Info Card */}
			<div style={{ marginBottom: 14, marginTop: 4 }}>
				<DiracAccountInfoCard />
			</div>

			{showModelOptions && (
				<>
					<DiracModelPicker currentMode={currentMode} isPopup={isPopup} showProviderRouting={true} />
				</>
			)}
		</div>
	)
}
