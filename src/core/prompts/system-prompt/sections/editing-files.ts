import { getDelimiter } from "../../../../utils/line-hashing"

export const getEditingFilesInstructions = () => {
	const delimiter = getDelimiter()
	return `## EDITING FILES INSTRUCTIONS

You have 4 file editing tools: 

1. \`write_to_file\` (for new files or complete overwrites) 
2. \`edit_file\` (for targeted edits) 
3. \`replace_symbol\` (for direct AST manipulation such as replacing a function or a symbol). updates AST precisely.
4. \`execute_command\` with commands like grep/awk/sed/find etc for bulk updates. CHEAPEST to execute and very useful for updating files in bulk. You can update the files without necessarily reading them. You can also write scripts that do the work for you. Using scripts to modify file content is a powerful way that avoids tedious work of executing many edit_file/write_to_file calls.



### LINE-HASH PROTOCOL
Every line returned by read tools (read_file, get_function, get_file_skeleton, search_files) follows the format: ANCHOR${delimiter}CONTENT

- ANCHOR: An opaque word-based tag (e.g., "Apple") used for stable referencing.
- CONTENT: The original line text, verbatim. Blank lines are shown as "ANCHOR${delimiter}".

Example read output:
Apple${delimiter}    def process(param1, param2):

### CRITICAL RULES FOR ANCHORS
1. FULL LINE MATCH: When providing \`anchor\` and \`end_anchor\`, you MUST include the ENTIRE line exactly as it appears in the read tool (Anchor Word + Delimiter + Content).
   - Correct: "Apple${delimiter}    def process(data):"
   - Incorrect: "Apple" or "Apple${delimiter}"
2. ORDERING: \`anchor\` MUST appear before or be the exact same line as \`end_anchor\` in the file.

### CRITICAL RULES FOR EDITING
1. INDENTATION: You are strictly responsible for indentation. \`replace\` destroys the original lines, so your \`text\` parameter MUST include the correct leading spaces for every single line you insert.
2. NO ANCHORS IN TEXT: The \`text\` parameter represents the raw, final code. NEVER include Anchor words or delimiters inside \`text\`.
3. THE MOST COMMON error type is not balancing braces/indents. You edits must make sure the you neither omit a closing brace not emit an extra closing brace. 
4. NON-OVERLAPPING: Multiple edits in the same file MUST NOT overlap.

### edit_file OPERATIONS
The \`edit_file\` tool supports three operations via the \`edit_type\` parameter:
- \`replace\`: Replaces an inclusive range of lines from \`anchor\` to \`end_anchor\`.
  * MULTI-LINE: You can replace a large block of code with a new multi-line block by using \`\\n\` in your \`text\` parameter.
  * SINGLE LINE: To replace or delete a single line, use that exact same line for BOTH \`anchor\` and \`end_anchor\`.
  * DELETE: To delete the range cleanly without leaving blank lines, use \`text: ""\`.
- \`insert_after\`: Inserts \`text\` as new line(s) immediately after \`anchor\`.
- \`insert_before\`: Inserts \`text\` as new line(s) immediately before \`anchor\`.

### EXAMPLES

#### Batched Multi-File Edit
To add imports, simplify logic, or refactor across multiple files, use the \`files\` parameter. 

Original Code (src/calculator.py):
\`\`\`
Apple${delimiter}def calculate_total(items):
Brave${delimiter}    total = 0
Cider${delimiter}    for item in items:
Delta${delimiter}        if item.price > 0:
Eagle${delimiter}            total += item.price
Fox${delimiter}    return total
\`\`\`

Original Code (src/user.ts):
\`\`\`
Grape${delimiter}interface User {
Hazel${delimiter}  id: string;
Index${delimiter}  name: string;
Joker${delimiter}  email: string;
Karma${delimiter}  age: number;
Lemon${delimiter}}
Mango${delimiter}
Nacho${delimiter}export function getUserDisplayName(user: User): string {
Ocean${delimiter}  if (!user.name) {
Piano${delimiter}    return "Anonymous";
Quail${delimiter}  }
River${delimiter}  return user.name;
Snake${delimiter}}
\`\`\`

Invoke edit_file with:
\`\`\`json
{
  "files": [
    {
      "path": "src/calculator.py",
      "edits":[
        {
          "edit_type": "insert_before",
          "anchor": "Apple${delimiter}def calculate_total(items):",
          "text": "from typing import List\\n"
        },
        {
          "edit_type": "replace",
          "anchor": "Brave${delimiter}    total = 0",
          "end_anchor": "Eagle${delimiter}            total += item.price",
          "text": "    total = sum(item.price for item in items if item.price > 0)"
        }
      ]
    },
    {
      "path": "src/user.ts",
      "edits":[
        {
          "edit_type": "replace",
          "anchor": "Karma${delimiter}  age: number;",
          "end_anchor": "Karma${delimiter}  age: number;",
          "text": ""
        },
        {
          "edit_type": "replace",
          "anchor": "Ocean${delimiter}  if (!user.name) {",
          "end_anchor": "River${delimiter}  return user.name;",
          "text": "  return user.name ? user.name : \\"Anonymous\\";"
        },
        {
          "edit_type": "insert_after",
          "anchor": "Snake${delimiter}}",
          "text": "\\nexport function isAnonymous(user: User): boolean {\\n  return !user.name;\\n}"
        }
      ]
    }
  ]
}
\`\`\`

Transformed Code (src/calculator.py):
\`\`\`python
# ---> CONSEQUENCE: \`insert_before\` Apple. The \\n in the text created the blank line (Zebra).
Yacht${delimiter}from typing import List
Zebra${delimiter}
Apple${delimiter}def calculate_total(items):
# ---> CONSEQUENCE: \`replace\` Brave through Eagle. The 4-space indentation was explicitly provided in the text.
Aero${delimiter}    total = sum(item.price for item in items if item.price > 0)
Fox${delimiter}    return total
\`\`\`

Transformed Code (src/user.ts):
\`\`\`typescript
Grape${delimiter}interface User {
Hazel${delimiter}  id: string;
Index${delimiter}  name: string;
Joker${delimiter}  email: string;
// ---> CONSEQUENCE: Karma was deleted cleanly because \`text\` was "". No blank line remains.
Lemon${delimiter}}
Mango${delimiter}
Nacho${delimiter}export function getUserDisplayName(user: User): string {
// ---> CONSEQUENCE: \`replace\` Ocean through River. We carefully did NOT include Snake (the closing brace) in \`end_anchor\`, so it remains intact below.
Bison${delimiter}  return user.name ? user.name : "Anonymous";
Snake${delimiter}}
// ---> CONSEQUENCE: \`insert_after\` Snake. The \\n at the start of the text created the blank line (Camel).
Camel${delimiter}
Dart${delimiter}export function isAnonymous(user: User): boolean {
Echo${delimiter}  return !user.name;
Flare${delimiter}}
\`\`\`

`
}
