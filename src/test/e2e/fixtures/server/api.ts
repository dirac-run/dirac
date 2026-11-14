export const E2E_REGISTERED_MOCK_ENDPOINTS = {
	"/api/v1": {
		GET: [
			"/generation",
			"/organizations/{orgId}/balance",
			"/organizations/{orgId}/members/{memberId}/usages",
			"/organizations/{orgId}/api-keys",
			"/organizations/{orgId}/remote-config",
			"/users/me",
			"/users/{userId}/balance",
			"/users/{userId}/usages",
			"/users/{userId}/payments",
		],
		POST: ["/chat/completions", "/auth/token"],
		PUT: ["/users/active-account"],
	},
	"/.test": {
		GET: [],
		POST: ["/auth", "/setUserBalance", "/setUserHasOrganization", "/setOrgBalance"],
		PUT: [],
	},
	"/health": {
		POST: [],
		GET: ["/", "/ping"],
		PUT: [],
	},
}


const edit_request = `<thinking>
The user wants me to replace the name "john" with "dirac" in the test.ts file. I can see the file content provided:

\`\`\`typescript
export const name = "john"
\`\`\`

I need to change "john" to "dirac". This is a simple targeted edit, so I should use the edit_file tool rather than write_to_file since I'm only changing one small part of the file.

I need to:
1. Use edit_file to change "john" to "dirac" in the test.ts file
2. Use "Apple" as the anchor.
</thinking>

I'll replace "john" with "dirac" in the test.ts file.

<edit_file>
<path>test.ts</path>
<edits>
[
  {
    "anchor": "Apple",
    "end_anchor": "Apple",
    "text": "export const name = "dirac""
  }
]
</edits>
</edit_file>`

export const E2E_MOCK_API_RESPONSES = {
	DEFAULT: "Hello! I'm a mock Dirac API response.",
	EDIT_REQUEST: edit_request,
}
