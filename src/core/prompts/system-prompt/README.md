# System Prompt Generation System

This documentation provides a comprehensive, minute-level detail of how Dirac's system prompt and tool definitions are generated, assembled, and optimized for different AI providers.

## High-Level Architecture

Dirac uses a modular, multi-stage pipeline to generate the final system prompt. The core logic resides in the `src/core/prompts/system-prompt/` directory, following a **Registry -> Builder -> Template** flow.

1.  **Orchestration**: `src/core/task/index.ts` calls `src/core/prompts/system-prompt/index.ts`.
2.  **Prompt Registry**: `src/core/prompts/system-prompt/registry/PromptRegistry.ts` coordinates prompt assembly from the request-scoped tool snapshot.
3.  **Assembly**: `src/core/prompts/system-prompt/registry/PromptBuilder.ts` coordinates the building process.
4.  **Resolution**: `src/core/prompts/system-prompt/templates/TemplateEngine.ts` injects dynamic values into the template.
5.  **Conversion**: `src/core/prompts/system-prompt/spec.ts` transforms internal specs into provider-native schemas.

---

## Detailed File-by-File Analysis

### 1. Entry Point: `src/core/prompts/system-prompt/index.ts`
- **Function**: `getSystemPrompt(context: SystemPromptContext, toolSnapshot: ToolRequestSnapshot)`
- **Role**: The main orchestrator. It fetches the singleton `PromptRegistry` and generates the `systemPrompt` string using the request-scoped tool snapshot.
- **Output**: Returns a `{ systemPrompt: string }` object. Native tools remain on `toolSnapshot.nativeTools`.

### 2. State & Registry: `src/core/prompts/system-prompt/registry/PromptRegistry.ts`
- **Role**: A singleton prompt registry that builds prompts from request-scoped tool snapshots; it does not discover or choose enabled tools.
- **Key Methods**:
    - `getInstance()`: Ensures only one registry exists.
    - `get(context, toolSnapshot)`: Creates a `PromptBuilder` and calls its `build()` method.
    - `nativeTools`: Compatibility field populated from `toolSnapshot.nativeTools` for the current request.

### 3. Build Orchestration: `src/core/prompts/system-prompt/registry/PromptBuilder.ts`
- **Role**: Handles the high-level logic of assembling the prompt.
- **`preparePlaceholders()`**: Gathers runtime environment variables:
    - `OS`: `process.platform`
    - `SHELL`: Current system shell or default `bash`.
    - `HOME_DIR`: User's home directory.
    - `CURRENT_DATE`: Today's date in ISO format.
- **`postProcess(prompt)`**: A critical cleanup phase using regex to ensure prompt quality:
    - **Cleanup**: Removes triple-newlines (`/\n\s*\n\s*\n/g`), trims whitespace, and removes empty section separators (`====`).
    - **Header Removal**: Strips empty markdown headers (`##`) that contain no content.
    - **Diff Protection**: Includes logic to avoid adding extra newlines inside `SEARCH/REPLACE` blocks or diff-like content, preserving the strict formatting required for file editing.

### 4. Tool Management: `src/core/prompts/system-prompt/registry/DiracToolSet.ts`
- **Role**: A utility class for provider-native conversion and dynamic subagent wrapper specs.
- **Snapshot source**: Enabled and context-filtered tool specs come from the task's `ToolRequestSnapshot`, not from `DiracToolSet` reading global registry state.
- **Dynamic Subagents**: Implements `getDynamicSubagentToolSpecs`, which dynamically generates tool definitions for subagents by loading configs from `src/core/task/tools/subagent/AgentConfigLoader.ts`.
- **Native conversion**: `convertSpecsToNativeTools(specs, context)` selects the correct converter from `src/core/prompts/system-prompt/spec.ts` based on the provider (Anthropic vs. OpenAI vs. Gemini) and maps snapshot specs to that format.

### 5. The Template: `src/core/prompts/system-prompt/template.ts`
- **Function**: `SYSTEM_PROMPT(context: SystemPromptContext)`
- **Role**: Returns the base template string containing Dirac's identity, editing protocols, and operating rules.
- **Placeholders**: Uses `{{PLACEHOLDER}}` tags (e.g., `{{OS}}`, `{{SHELL}}`, `{{CWD}}`) that will be resolved later.
- **Conditional Content**: Contains inline logic to add/remove instructions based on flags like `enableParallelToolCalling` or `supportsBrowserUse`.

### 6. Template Engine: `src/core/prompts/system-prompt/templates/TemplateEngine.ts`
- **Role**: Performs string replacement for placeholders.
- **Nested Object Support**: Uses `getNestedValue` to support dot-notation (e.g., `{{browserSettings.viewport.width}}`) using `path.split(".").reduce(...)`.
- **Safety**: Includes `escape` and `unescape` methods to prevent accidental resolution of placeholders that should remain literal.

### 7. Native Schema Conversion: `src/core/prompts/system-prompt/spec.ts`
- **Role**: Transforms internal `DiracToolSpec` objects into the specific JSON schemas required by LLM providers.
- **Anthropic (`toolSpecInputSchema`)**: Generates an `input_schema` object with standard property/required fields.
- **OpenAI (`toolSpecFunctionDefinition`)**: Generates a standard OpenAI function definition, setting `additionalProperties: false` and `strict: false`.
- **Gemini (`toolSpecFunctionDeclarations`)**: Uses a recursive `toGoogleSchema` function to map parameter types to Gemini's uppercase type system (e.g., `string` -> `STRING`, `array` -> `ARRAY`).

---

## The System Prompt Generation Lifecycle

1.  **Request Initiation**: In `src/core/task/index.ts`, `recursivelyMakeDiracRequests` is called for every turn in the task loop.
2.  **Context Preparation**: `Task` creates a `SystemPromptContext` using the `StateManager` to fetch user settings and global state.
3.  **Building the String**:
    - `src/core/prompts/system-prompt/registry/PromptBuilder.ts` calls the `src/core/prompts/system-prompt/template.ts` template.
    - `src/core/prompts/system-prompt/templates/TemplateEngine.ts` resolves all standard and context-specific placeholders.
    - `PromptBuilder` performs regex-based post-processing cleanup.
4.  **Managing Rules**:
    - Global rules are loaded from the user's global `.clinerules/` directory.
    - Local project rules are loaded from the workspace (supporting `.clinerules`, `.cursorrules`, etc.) and injected into the `USER'S CUSTOM INSTRUCTIONS` section.
5.  **Native Tool Generation**:
    - `Task.attemptApiRequest()` asks `ToolExecutor` for a request-scoped `ToolRequestSnapshot` after building the real `SystemPromptContext`.
    - `DiracToolSet.convertSpecsToNativeTools(...)` converts that snapshot's prompt-visible specs into the provider's native format.
    - **Important**: In this mode, the system prompt string itself does **not** contain tool definitions, as the provider receives them as a separate structured parameter.
6.  **Final Output**: The `systemPrompt` string is returned to the `Task` runner, which passes `toolSnapshot.nativeTools` to the API via `src/core/api/index.ts`.

---

## Key Principles & Best Practices

### Native Tool Calling First
Dirac is built on a **Native First** architecture. Native tool calling is more token-efficient and less prone to hallucination than legacy XML-style tags.
- The `src/core/assistant-message/parse-assistant-message.ts` parser (via `parseAssistantMessageV2`) is optimized for this flow, primarily focusing on text and reasoning blocks while assuming tools are handled via structured API response.

### Modularity
Instructions are separated into sections (Identity, Tool Guidelines, Editing Files, Rules) defined in `src/core/prompts/system-prompt/templates/placeholders.ts`.

### Snapshots & Testing
Every major change to the system prompt must be validated against the snapshots in `src/core/prompts/system-prompt/__tests__/__snapshots__/`.
- Use `src/core/prompts/system-prompt/__tests__/integration.test.ts` to verify that your changes produce the expected output across different providers and configurations.
- To update snapshots after intentional changes:
    ```bash
    UPDATE_SNAPSHOTS=true npm run test:unit
    ```
