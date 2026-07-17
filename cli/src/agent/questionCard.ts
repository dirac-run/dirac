import {
    CardStatus,
    type DiracMessage,
    DiracMessageType,
} from "@shared/ExtensionMessage";

export const ASK_FOLLOWUP_QUESTION_TOOL_ID = "ask_followup_question";

/** Identify cards created by the follow-up-question flow without classifying generic feedback cards. */
export function isFollowupQuestionCard(message: DiracMessage): boolean {
	if (message.content.type !== DiracMessageType.CARD) return false;

	const { card } = message.content;
	if (card.status !== CardStatus.WAITING_FOR_INPUT) return false;
	if (!card.requireFeedback || card.requireApproval) return false;

	return (
		card.rawInput?.tool === ASK_FOLLOWUP_QUESTION_TOOL_ID ||
		card.header.startsWith("Question:")
	);
}
