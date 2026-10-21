import { and, desc, eq, inArray } from "drizzle-orm";
import {
	addFields,
	addRecipients,
	auditEvents,
	createEnvelope,
	type EmailDeliveryOptions,
	envelopeRecipients,
	envelopes,
	finalDocuments,
	sendEnvelope,
	sourceDocuments,
	uploadSourcePdfDocument,
} from "@/db/envelope";
import { getDb } from "@/db/setup";
import { sha256Hex } from "@/hono/api/envelope-route-helpers";
import { prepareContractPdf } from "./contracts-pdf";
import {
	ContractError,
	type ContractSummary,
	type CreateContractRequest,
} from "./contracts-schema";

export async function createAndSendContract(input: {
	email: string;
	request: CreateContractRequest;
	documentsBucket: R2Bucket;
	emailDelivery: EmailDeliveryOptions;
}): Promise<ContractSummary> {
	if (input.email.trim().toLowerCase() === input.request.recipient.email) {
		throw new ContractError(
			"EXTERNAL_RECIPIENT_REQUIRED",
			"Choose the external person who should sign this contract",
		);
	}
	const prepared = await prepareContractPdf(input.request);
	const { envelope } = await createEnvelope({ createdBy: input.email });
	await getDb().insert(auditEvents).values({
		envelopeId: envelope.id,
		recipientId: null,
		eventType: "contract.created",
		message: input.request.title,
	});
	await uploadSourcePdfDocument({
		envelopeId: envelope.id,
		uploadedBy: input.email,
		bytes: prepared.bytes,
		sha256: await sha256Hex(prepared.bytes),
		contentType: "application/pdf",
		originalFilename: input.request.pdf.filename,
		documentsBucket: input.documentsBucket,
	});
	const [recipient] = await addRecipients(envelope.id, { recipients: [input.request.recipient] });
	if (!recipient) throw new Error("Contract recipient could not be created");
	await addFields(envelope.id, {
		fields: prepared.fields.map((field) => ({ ...field, recipientId: recipient.id })),
	});
	await sendEnvelope(envelope.id, input.email, { emailDelivery: input.emailDelivery });
	const contract = await getContract(input.email, envelope.id);
	if (!contract) throw new Error("Contract result unavailable");
	return contract;
}

export async function listContracts(email: string): Promise<ContractSummary[]> {
	const rows = await getDb()
		.select()
		.from(envelopes)
		.where(eq(envelopes.createdBy, email.trim().toLowerCase()))
		.orderBy(desc(envelopes.createdAt))
		.limit(100);
	return projectContracts(rows.filter((row) => row.status !== "deleted"));
}

export async function getContract(email: string, id: string): Promise<ContractSummary | null> {
	const rows = await getDb()
		.select()
		.from(envelopes)
		.where(and(eq(envelopes.id, id), eq(envelopes.createdBy, email.trim().toLowerCase())))
		.limit(1);
	const row = rows.find(
		(candidate) =>
			candidate.id === id &&
			candidate.createdBy === email.trim().toLowerCase() &&
			candidate.status !== "deleted",
	);
	if (!row) return null;
	return (await projectContracts([row]))[0] ?? null;
}

export async function getContractFinalPdf(
	email: string,
	id: string,
): Promise<typeof finalDocuments.$inferSelect | null> {
	const contract = await getContract(email, id);
	if (!contract || contract.status !== "completed") return null;
	const rows = await getDb()
		.select()
		.from(finalDocuments)
		.where(eq(finalDocuments.envelopeId, id))
		.orderBy(desc(finalDocuments.createdAt))
		.limit(1);
	return rows.find((row) => row.envelopeId === id) ?? null;
}

async function projectContracts(
	rows: Array<typeof envelopes.$inferSelect>,
): Promise<ContractSummary[]> {
	if (rows.length === 0) return [];
	const ids = rows.map((row) => row.id);
	const db = getDb();
	const [recipients, sources, finals, titles] = await Promise.all([
		db.select().from(envelopeRecipients).where(inArray(envelopeRecipients.envelopeId, ids)),
		db
			.select()
			.from(sourceDocuments)
			.where(inArray(sourceDocuments.envelopeId, ids))
			.orderBy(desc(sourceDocuments.version)),
		db
			.select()
			.from(finalDocuments)
			.where(inArray(finalDocuments.envelopeId, ids))
			.orderBy(desc(finalDocuments.createdAt)),
		db
			.select()
			.from(auditEvents)
			.where(
				and(inArray(auditEvents.envelopeId, ids), eq(auditEvents.eventType, "contract.created")),
			),
	]);
	return rows.map((row) => {
		const source = sources.find((candidate) => candidate.envelopeId === row.id);
		const final = finals.find((candidate) => candidate.envelopeId === row.id);
		const title = titles.find((candidate) => candidate.envelopeId === row.id)?.message;
		return {
			id: row.id,
			title: title ?? source?.originalFilename.replace(/\.pdf$/i, "") ?? "Untitled contract",
			status: row.status,
			recipients: recipients
				.filter((candidate) => candidate.envelopeId === row.id)
				.map((recipient) => ({
					name: recipient.name,
					email: recipient.email,
					status: recipient.status,
				})),
			createdAt: row.createdAt.toISOString(),
			completedAt: row.status === "completed" && final ? final.createdAt.toISOString() : null,
			downloadUrl: row.status === "completed" && final ? `/api/contracts/${row.id}/pdf` : null,
		};
	});
}
