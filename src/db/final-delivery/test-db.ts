import type { Table } from "drizzle-orm";
import { envelopeRecipients, envelopes, finalDocuments, signerTokens } from "@/db/envelope/table";
import { contractFinalDeliveryOutbox } from "./table";

type Row = Record<string, unknown>;
/** Stateful adapter used only by legacy domain DB fixtures; real SQL is covered by PGlite. */
export function createFinalDeliveryTestStatements(
	rows: (table: unknown) => Row[],
	insert: (table: Table, input: Row | Row[]) => Promise<Row[]>,
) {
	async function recordFinalDelivery(params: unknown[]): Promise<Row[]> {
		const document = rows(finalDocuments).find((row) => row.id === params[0]);
		if (!document) return [];
		const envelope = rows(envelopes).find((row) => row.id === document.envelopeId);
		const recipients = rows(envelopeRecipients).filter(
			(row) => row.envelopeId === document.envelopeId,
		);
		if (envelope?.status !== "completed" || recipients.some((row) => row.status !== "completed"))
			return [];
		const participants = participantPaths(envelope, recipients);
		for (const [toEmail, accessPath] of participants) {
			if (
				!rows(contractFinalDeliveryOutbox).some(
					(row) =>
						row.finalDocumentId === document.id &&
						row.finalSha256 === document.sha256 &&
						row.toEmail === toEmail,
				)
			)
				await insert(contractFinalDeliveryOutbox, {
					envelopeId: envelope.id,
					finalDocumentId: document.id,
					finalSha256: document.sha256,
					toEmail,
					accessPath,
					status: "queued",
					firstAttemptAt: null,
				});
		}
		return [];
	}
	function participantPaths(envelope: Row, recipients: Row[]): Map<string, string> {
		const participants = new Map<string, string>();
		participants.set(
			String(envelope.createdBy).trim().toLowerCase(),
			`/my-documents/${envelope.id}`,
		);
		for (const recipient of recipients) {
			const email = String(recipient.email).trim().toLowerCase();
			if (participants.has(email)) continue;
			const token = rows(signerTokens)
				.filter((row) => row.recipientId === recipient.id && row.status === "active")
				.sort((left, right) => Number(right.createdAt) - Number(left.createdAt))[0];
			participants.set(
				email,
				token ? `/completed-documents/${token.token}` : `/my-documents/${envelope.id}`,
			);
		}
		return participants;
	}

	function refreshFinalLinks(params: unknown[]): Row[] {
		const intent = rows(contractFinalDeliveryOutbox).find(
			(row) =>
				row.finalDocumentId === params[0] && row.status === "queued" && row.firstAttemptAt === null,
		);
		if (intent)
			for (const token of rows(signerTokens)) {
				if (token.envelopeId === intent.envelopeId && token.status === "active")
					token.expiresAt = new Date(Date.now() + 7 * 86400_000);
			}
		return [];
	}

	return { recordFinalDelivery, refreshFinalLinks };
}
