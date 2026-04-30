import { DiracDefaultTool } from "../../shared/tools"

export const TOOL_EXAMPLES: Partial<Record<DiracDefaultTool, string>> = {
	[DiracDefaultTool.ASK]: '{"question": "What should I do next?"}',
	[DiracDefaultTool.ATTEMPT]: '{"result": "Summary of work done..."}',
	[DiracDefaultTool.SUMMARIZE_TASK]: '{"context": "Detailed summary of the conversation..."}',
	[DiracDefaultTool.DIAGNOSTICS_SCAN]: '{"paths": ["src"]}',
	[DiracDefaultTool.BROWSER]: '{"action": "launch", "url": "https://google.com"}',
	[DiracDefaultTool.EDIT_FILE]:
		'{"files": [{"path": "src/index.ts", "edits": [{"edit_type": "replace", "anchor": "...", "end_anchor": "...", "text": "new content"}]}]}',
	[DiracDefaultTool.REPLACE_SYMBOL]:
		'{"replacements": [{"path": "src/main.ts", "symbol": "main", "text": "..."}]}',
	[DiracDefaultTool.RENAME_SYMBOL]:
		'{"paths": ["src"], "existing_symbol": "oldName", "new_symbol": "newName"}',
	[DiracDefaultTool.BASH]: '{"commands": ["ls -R"]}',
	[DiracDefaultTool.GET_FUNCTION]: '{"paths": ["src/main.ts"], "function_names": ["main"]}',
	[DiracDefaultTool.GET_FILE_SKELETON]: '{"paths": ["src/main.ts"]}',
	[DiracDefaultTool.FIND_SYMBOL_REFERENCES]:
		'{"paths": ["src"], "symbols": ["main"]}',
	[DiracDefaultTool.LIST_FILES]: '{"paths": ["src"]}',
	[DiracDefaultTool.NEW_TASK]: '{"context": "Detailed summary of the conversation..."}',
	[DiracDefaultTool.PLAN_MODE]: '{"response": "I have gathered context..."}',
	[DiracDefaultTool.FILE_READ]: '{"paths": ["src/main.ts"]}',
	[DiracDefaultTool.SEARCH]: '{"paths": ["src"], "regex": "TODO"}',
	[DiracDefaultTool.USE_SUBAGENTS]: '{"prompt_1": "...", "prompt_2": "..."}',
	[DiracDefaultTool.USE_SKILL]: '{"skill_name": "skill-name"}',
	[DiracDefaultTool.LIST_SKILLS]: '{}',
	[DiracDefaultTool.GENERATE_EXPLANATION]: '{"title": "Changes in last commit", "from_ref": "HEAD~1"}',
	[DiracDefaultTool.FILE_NEW]: '{"path": "src/new-file.ts", "content": "export const x = 1"}',
}
