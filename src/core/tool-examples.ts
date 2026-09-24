import { DiracDefaultTool } from "@shared/tools"

export const TOOL_EXAMPLES: Partial<Record<DiracDefaultTool, string>> = {
	[DiracDefaultTool.RESPOND]: '{"operation":"complete","text":"Summary of work done..."}',
	[DiracDefaultTool.CONDENSE]: '{"context": "Detailed summary of the conversation..."}',
	[DiracDefaultTool.DIAGNOSTICS_SCAN]: '{"paths": ["src"]}',
	[DiracDefaultTool.BROWSER]: '{"action": "launch", "url": "https://google.com"}',
	[DiracDefaultTool.EDIT_FILE]:
		'{"files": [{"path": "src/index.ts", "edits": [{"edit_type": "replace", "anchor": "...", "end_anchor": "...", "text": "new content"}]}]}',
	[DiracDefaultTool.EDIT_AST]:
		'{"operation": "replace", "targets": [{"path": "src/main.ts", "symbol": "main", "replacement": "..."}]}',
	[DiracDefaultTool.EXECUTE_COMMAND]: '{"commands": ["ls -R"]}',
	[DiracDefaultTool.INSPECT_AST]: '{"operation": "implementation", "paths": ["src/main.ts"], "symbols": ["main"]}',
	[DiracDefaultTool.LIST_FILES]: '{"paths": ["src"]}',
	[DiracDefaultTool.NEW_TASK]: '{"context": "Detailed summary of the conversation..."}',
	[DiracDefaultTool.FILE_READ]: '{"paths": ["src/main.ts"]}',
	[DiracDefaultTool.SEARCH]: '{"paths": ["src"], "regex": "TODO"}',
	[DiracDefaultTool.USE_SUBAGENTS]:
		'{"subagents": [{"prompt": "..."}, {"prompt": "...", "timeout": 120, "include_history": true}]}',
	[DiracDefaultTool.USE_SKILL]: '{"skill_name": "skill-name"}',
	[DiracDefaultTool.LIST_SKILLS]: "{}",
	[DiracDefaultTool.FILE_NEW]: '{"path": "src/new-file.ts", "content": "export const x = 1"}',
}
