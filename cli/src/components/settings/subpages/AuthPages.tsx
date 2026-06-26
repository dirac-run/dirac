import React from "react"
import { Box, Text } from "ink"
import Spinner from "ink-spinner"
import { COLORS } from "../../../constants/colors"
import { terminalLink } from "../../../utils/clipboard"

interface CodexAuthPageProps {
	codexAuthUrl: string | null
	copied: boolean
}

export const CodexAuthPage: React.FC<CodexAuthPageProps> = ({ codexAuthUrl, copied }) => (
	<Box flexDirection="column">
		<Box>
			<Text color={COLORS.primaryBlue}>
				<Spinner type="dots" />
			</Text>
			<Text color="white"> Waiting for ChatGPT sign-in...</Text>
		</Box>
		<Box marginTop={1}>
			<Text color="gray">Sign in with your ChatGPT account in the browser.</Text>
		</Box>
		{codexAuthUrl && (
			<Box flexDirection="column" marginTop={1}>
				<Text bold color="cyan">
					{terminalLink("👉 Sign in to ChatGPT", codexAuthUrl)}
				</Text>
				<Box marginTop={1}>
					{copied ? (
						<Text color="green">✔ Copied to clipboard!</Text>
					) : (
						<Text color="gray">(press 'c' to copy URL)</Text>
					)}
				</Box>
				<Box marginTop={1}>
					<Text color="yellow">Note: If you are on a remote machine, you may need to set up SSH port forwarding:</Text>
				</Box>
				<Text color="gray">ssh -L 1455:localhost:1455 your-remote-host</Text>
			</Box>
		)}
		<Box marginTop={1}>
			<Text color="gray">Requires ChatGPT Plus, Pro, or Team subscription.</Text>
		</Box>
		<Box marginTop={1}>
			<Text color="gray">Esc to cancel</Text>
		</Box>
	</Box>
)

interface GithubAuthPageProps {
	githubAuthData: {
		verification_uri: string
		user_code: string
	}
}

export const GithubAuthPage: React.FC<GithubAuthPageProps> = ({ githubAuthData }) => (
	<Box flexDirection="column">
		<Box>
			<Text color={COLORS.primaryBlue}>
				<Spinner type="dots" />
			</Text>
			<Text color="white"> Waiting for GitHub authorization...</Text>
		</Box>
		<Box marginTop={1}>
			<Text color="white">1. Open: </Text>
			<Text color="cyan" bold underline>
				{githubAuthData.verification_uri}
			</Text>
		</Box>
		<Box marginTop={1}>
			<Text color="white">2. Enter code: </Text>
			<Text color="yellow" bold>
				{githubAuthData.user_code}
			</Text>
		</Box>
		<Box marginTop={1}>
			<Text color="gray">The browser should have opened automatically.</Text>
		</Box>
		<Box marginTop={1}>
			<Text color="gray">Esc to cancel</Text>
		</Box>
	</Box>
)

interface AuthErrorPageProps {
	error: string
}

export const AuthErrorPage: React.FC<AuthErrorPageProps> = ({ error }) => (
	<Box flexDirection="column">
		<Text bold color="red">
			ChatGPT sign-in failed
		</Text>
		<Box marginTop={1}>
			<Text color="yellow">{error}</Text>
		</Box>
		<Box marginTop={1}>
			<Text color="gray">Press any key to continue</Text>
		</Box>
	</Box>
)
