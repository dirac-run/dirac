// Prompt for initial list creation
const initial = `
# task_progress RECOMMENDED - ACT MODE ACTIVATED

**You've switched to ACT MODE.** It is recommended to create a comprehensive todo list in your NEXT tool call using the \`task_progress\` parameter to track your progress.

**Format:**
- [ ] Task to be done
- [x] Completed task

Include all major implementation steps, testing, and documentation to ensure nothing is missed.`

// For when recommending but not requiring a list
const listInstructionsRecommended = `
1. Include a todo list using the \`task_progress\` parameter in your next tool call.
2. Create a comprehensive checklist of all steps needed using markdown: \`- [ ]\` for incomplete, \`- [x]\` for complete.

A list provides a clear roadmap and helps track progress throughout the task.`

// Prompt for reminders to update the list periodically
const reminder = `
1. Update your todo list using the \`task_progress\` parameter in your next tool call whenever you make progress or update the plan. If no changes have occurred, you may omit this parameter to save tokens.
2. Review each item: mark completed with \`- [x]\`, keep incomplete as \`- [ ]\`, and add any newly discovered steps.
3. Ensure the list accurately reflects the current state of the task.`

const completed = `
**All {{totalItems}} items completed!**

{{currentFocusChainChecklist}}

**Next Steps:**
- Use \`attempt_completion\` if the task is fully finished and meets all requirements.
- If you've discovered additional work (new features, edge cases), create a new \`task_progress\` list to track it.`

const planModeReminder = `
# task_progress (Optional - Plan Mode)

You may include a preliminary todo list using the \`task_progress\` parameter.

${reminder}`

const recommended = `
# task_progress RECOMMENDED

It is recommended to include a todo list using the \`task_progress\` parameter.

${listInstructionsRecommended}
`

const apiRequestCount = `
# task_progress

You've made {{apiRequestCount}} API requests without a \`task_progress\` parameter. Please create one to track remaining work.

${reminder}
`

export const FocusChainPrompts = {
	initial,
	reminder,
	recommended,
	planModeReminder,
	completed,
	apiRequestCount,
}
