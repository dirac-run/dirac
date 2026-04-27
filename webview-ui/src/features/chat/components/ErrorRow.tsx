import { DiracMessage } from "@shared/ExtensionMessage"
import { memo } from "react"
import { useDiracAuth, useDiracSignIn } from "@/context/DiracAuthContext"
import CreditLimitError from "@/features/chat/components/CreditLimitError"
import { DiracError, DiracErrorType } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"

const _errorColor = "var(--vscode-errorForeground)"

interface ErrorRowProps {
	message: DiracMessage
	errorType: "error" | "mistake_limit_reached" | "diff_error" | "diracignore_error"
	apiRequestFailedMessage?: string
	apiReqStreamingFailedMessage?: string
}

const ErrorRow = memo(({ message, errorType, apiRequestFailedMessage, apiReqStreamingFailedMessage }: ErrorRowProps) => {
	const { diracUser } = useDiracAuth()
	const rawApiError = apiRequestFailedMessage || apiReqStreamingFailedMessage

	const { isLoginLoading, handleSignIn } = useDiracSignIn()

	const renderErrorContent = () => {
		switch (errorType) {
			case "error":
			case "mistake_limit_reached":
				// Handle API request errors with special error parsing
				if (rawApiError) {
					// FIXME: DiracError parsing should not be applied to non-Dirac providers, but it seems we're using diracErrorMessage below in the default error display
					const diracError = DiracError.parse(rawApiError)
					const errorMessage = diracError?._error?.message || diracError?.message || rawApiError
					const requestId = diracError?._error?.request_id
					const providerId = diracError?.providerId || diracError?._error?.providerId
					const isDiracProvider = providerId === "dirac"
					const errorCode = diracError?._error?.code

					if (diracError?.isErrorType(DiracErrorType.Balance)) {
						const errorDetails = diracError._error?.details
						return (
							<CreditLimitError
								buyCreditsUrl={errorDetails?.buy_credits_url}
								currentBalance={errorDetails?.current_balance}
								message={errorDetails?.message}
								totalPromotions={errorDetails?.total_promotions}
								totalSpent={errorDetails?.total_spent}
							/>
						)
					}

					if (diracError?.isErrorType(DiracErrorType.RateLimit)) {
						return (
							<p className="m-0 whitespace-pre-wrap text-error wrap-anywhere">
								{errorMessage}
								{requestId && <div>Request ID: {requestId}</div>}
							</p>
						)
					}

					return (
						<p className="m-0 whitespace-pre-wrap text-error wrap-anywhere flex flex-col gap-3">
							{/* Display the well-formatted error extracted from the DiracError instance */}

							<header>
								{providerId && <span className="uppercase">[{providerId}] </span>}
								{errorCode && <span>{errorCode}</span>}
								{errorMessage}
								{requestId && <div>Request ID: {requestId}</div>}
							</header>

							{/* Windows Powershell Issue */}
							{errorMessage?.toLowerCase()?.includes("powershell") && (
								<div>
									It seems like you're having Windows PowerShell issues, please see this{" "}
									<a
										className="underline text-inherit"
										href="https://github.com/dirac-run/dirac/wiki/TroubleShooting-%E2%80%90-%22PowerShell-is-not-recognized-as-an-internal-or-external-command%22">
										troubleshooting guide
									</a>
									.
								</div>
							)}

							{/* Display raw API error if different from parsed error message */}
							{errorMessage !== rawApiError && <div>{rawApiError}</div>}

							{/* Display Login button for non-logged in users using the Dirac provider */}
							<div>
								{/* The user is signed in or not using dirac provider */}
								{isDiracProvider && !diracUser ? (
									<Button className="w-full mb-4" disabled={isLoginLoading} onClick={handleSignIn}>
										Sign in to Dirac
										{isLoginLoading && (
											<span className="ml-1 animate-spin">
												<span className="codicon codicon-refresh" />
											</span>
										)}
									</Button>
								) : (
									<span className="mb-4 text-description">(Click "Retry" below)</span>
								)}
							</div>
						</p>
					)
				}

				// Regular error message
				return <p className="m-0 mt-0 whitespace-pre-wrap text-error wrap-anywhere">{message.text}</p>

			case "diff_error":
				return (
					<div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
						<div>The model used search patterns that don't match anything in the file. Retrying...</div>
					</div>
				)

			case "diracignore_error":
				return (
					<div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
						<div>
							Dirac tried to access <code>{message.text}</code> which is blocked by the <code>.diracignore</code>
							file.
						</div>
					</div>
				)

			default:
				return null
		}
	}

	// For diff_error and diracignore_error, we don't show the header separately
	if (errorType === "diff_error" || errorType === "diracignore_error") {
		return renderErrorContent()
	}

	// For other error types, show header + content
	return renderErrorContent()
})

export default ErrorRow
