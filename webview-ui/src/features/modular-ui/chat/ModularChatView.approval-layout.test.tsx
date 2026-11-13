import { CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useChatStore } from "@/features/chat/store/chatStore"

vi.mock("@/app/store/appStore", () => ({ useAppStore: (selector: (state: unknown) => unknown) => selector({ version: "test" }) }))
vi.mock("@/context/PlatformContext", () => ({ useShowNavbar: () => false }))
vi.mock("@/entities/task/store/taskStore", () => ({ useTaskStore: (selector: (state: unknown) => unknown) => selector({ taskHistory: [] }) }))
vi.mock("@/features/settings/store/settingsStore", () => ({ useSettingsStore: (selector: (state: unknown) => unknown) => selector({ mode: "act" }) }))
vi.mock("@/features/settings/components/utils/providerUtils", () => ({ normalizeApiConfiguration: () => ({ selectedModelInfo: {} }) }))
vi.mock("@/shared/ui/Navbar", () => ({ Navbar: () => null }))
vi.mock("./context/InteractionStateContext", () => ({ InteractionState: { RUNNING: "running" }, useInteractionState: () => ({ state: "running" }) }))
vi.mock("./hooks/useChatState", () => ({ useChatState: () => ({ sendingDisabled: false, expandedRows: {}, setExpandedRows: vi.fn(), textAreaRef: { current: null } }) }))
vi.mock("./hooks/useMessageHandlers", () => ({ useMessageHandlers: () => ({ executeButtonAction: vi.fn() }) }))
vi.mock("./hooks/useScrollBehavior", () => ({ useScrollBehavior: () => ({}) }))
vi.mock("./decorators/view/ActionButtonsDecorator", () => ({ ActionButtonsDecorator: { id: "actions", render: () => null } }))
vi.mock("./decorators/view/AutoApproveDecorator", () => ({ AutoApproveDecorator: { id: "auto", render: () => null } }))
vi.mock("./sections/WelcomeSection", () => ({ WelcomeSection: { id: "welcome", shouldRender: () => false } }))
vi.mock("./sections/GoalSection", () => ({ GoalSection: { id: "goal", shouldRender: () => false } }))
vi.mock("./sections/TaskSection", () => ({ TaskSection: { id: "task", shouldRender: () => false } }))
vi.mock("./sections/MessagesSection", () => ({ MessagesSection: { id: "messages", shouldRender: () => true, render: () => <section aria-label="Conversation messages" /> } }))
vi.mock("./sections/InputSection", () => ({ InputSection: { id: "input", shouldRender: () => true, render: () => <textarea aria-label="Composer" defaultValue="Independent draft" /> } }))

import { ModularChatView } from "./ModularChatView"
import { readFileSync } from "node:fs"

const trayCss = readFileSync("src/features/modular-ui/chat/components/ApprovalTray.css", "utf8")

afterEach(cleanup)

describe("fixed approval layout", () => {
	it("places tray outside scrolling transcript immediately above independent composer", () => {
		useChatStore.getState().applyExtensionState({
			diracMessages: [{
				id: "permission", ts: 1, content: {
					type: DiracMessageType.CARD, card: {
						id: "permission", header: "Execute", body: "npm install", status: CardStatus.WAITING_FOR_INPUT,
						renderType: "text", requireApproval: true,
					}
				}
			}],
			uiActionState: { globalButtons: [], cardButtons: [], sendingDisabled: false, pendingApprovalCardIds: ["permission"] },
		})
		render(<ModularChatView isHidden={false} showAnnouncement={false} hideAnnouncement={vi.fn()} showHistoryView={vi.fn()} />)
		const tray = screen.getByRole("region", { name: "Pending approval" })
		const transcript = screen.getByRole("region", { name: "Conversation messages" })
		const composer = screen.getByRole("textbox", { name: "Composer" })
		expect(transcript).not.toContainElement(tray)
		expect(tray.nextElementSibling).toContainElement(composer)
		expect(tray.parentElement).toContainElement(transcript)
		expect(transcript.parentElement).toHaveClass("flex-1", "min-h-0", "overflow-hidden")
		expect(composer).toHaveValue("Independent draft")
		expect(composer).toBeEnabled()
	})

	it("uses a nonshrinking tray, equal-width once/reject columns and a shared neutral option surface", () => {
		expect(trayCss).toMatch(/\.approval-tray\s*\{[^}]*flex:\s*0 0 auto/s)
		expect(trayCss).toMatch(/\.approval-tray-once\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/s)
		expect(trayCss).toMatch(/\.approval-tray-option\s*\{[^}]*border:\s*1px solid var\(--approval-border\)[^}]*background:\s*var\(--approval-background\)/s)
	})
})
