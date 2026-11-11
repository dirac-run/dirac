import { Box, Text, useInput } from "ink";
// biome-ignore lint/correctness/noUnusedImports: CLI uses the classic JSX runtime.
import React, { useState } from "react";
import { SearchableList } from "../SearchableList";
import { theme } from "../../constants/theme";

/** Select one short topic at a time so technical notes remain readable on small terminals. */
export function SandboxTechnicalDetails({ details, onClose }: { details: string; onClose: () => void }) {
	const topics = details.split("\n\n").flatMap((paragraph) => paragraph.length > 650 ? paragraph.split(/(?<=\.) /) : [paragraph])
		.map((text, index) => ({ id: `detail:${index}`, label: text.length > 52 ? `${text.slice(0, 52)}…` : text, text }))
	const [selected, setSelected] = useState<(typeof topics)[number]>()
	useInput((_input, key) => {
		if (!key.escape) return
		if (selected) setSelected(undefined)
		else onClose()
	})
	return <Box flexDirection="column">
		<Text bold>Technical details</Text>
		{selected ? <Text color={theme.text}>{selected.text}</Text> : <SearchableList key="topics" items={topics} maxRows={6} onSelect={setSelected} />}
		<Text color={theme.muted}>{selected ? "Esc returns to topics" : "Enter reads topic · Esc back"}</Text>
	</Box>
}
