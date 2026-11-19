import { eq } from "drizzle-orm";
import { getDb } from "@/db/setup";
import {
	buildPartnerVerificationEmail,
	buildSenderSigningEmail,
	deliverTransactionalEmail,
	type EmailDeliveryOptions,
	isResendConfigured,
	toAbsoluteDeliveryUrl,
} from "./email-delivery";
import {
	type EnvelopeField,
	EnvelopeFieldSchema,
	EnvelopeSchema,
	type Recipient,
	RecipientSchema,
	type ResendInvitationResult,
	type SendEnvelopeResult,
	type SignatureProfile,
	SignatureProfileSchema,
	type SignerToken,
	SignerTokenSchema,
} from "./schema";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	signatureProfiles,
	signerTokens,
	sourceDocuments,
} from "./table";

const partnerVerificationTtlMs = 7 * 24 * 60 * 60 * 1000;

type DeliveryLink = SendEnvelopeResult["verificationLinks"][number] & {
	kind: "sender_signing" | "partner_verification";
};

interface EnvelopeDeliveryOptions {
	emailDelivery?: EmailDeliveryOptions;
}

export async function sendEnvelope(
	envelopeId: string,
	sentBy: string,
	options: EnvelopeDeliveryOptions = {},
): Promise<SendEnvelopeResult> {
	const db = getDb();
	const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, envelopeId)).limit(1);
	const parsedEnvelope = envelope ? EnvelopeSchema.parse(envelope) : null;
	if (!parsedEnvelope) throw new Error("Envelope not found");
	if (parsedEnvelope.status === "sent") {
		return getExistingSendResult(envelopeId, parsedEnvelope.sentBy ?? sentBy);
	}
	if (parsedEnvelope.status !== "draft") throw new Error("Envelope must be draft");

	const documents = await db
		.select()
		.from(sourceDocuments)
		.where(eq(sourceDocuments.envelopeId, envelopeId))
		.limit(1);
	if (documents.length === 0) throw new Error("Envelope source PDF required");

	const recipients = (
		await db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, envelopeId))
			.limit(10)
	).map((recipient) => RecipientSchema.parse(recipient));
	if (recipients.length === 0) throw new Error("Envelope recipients required");
	const fields = (
		await db
			.select()
			.from(envelopeFields)
			.where(eq(envelopeFields.envelopeId, envelopeId))
			.limit(100)
	).map((field) => EnvelopeFieldSchema.parse(field));
	const recipientIdsWithFields = new Set(fields.map((field) => field.recipientId));
	if (recipients.some((recipient) => !recipientIdsWithFields.has(recipient.id))) {
		throw new Error("Envelope recipient fields required");
	}

	const issuedAt = new Date();
	const expiresAt = new Date(issuedAt.getTime() + partnerVerificationTtlMs);
	const senderRecipients = recipients.filter(
		(recipient) => isSenderRecipient(recipient, sentBy) && recipient.status !== "completed",
	);
	const partnerRecipients = recipients.filter((recipient) => !isSenderRecipient(recipient, sentBy));
	await completeSenderRecipients({
		envelopeId,
		sentBy,
		senderRecipients,
		fields,
		issuedAt,
	});

	const tokens =
		partnerRecipients.length > 0
			? await db
					.insert(signerTokens)
					.values(
						partnerRecipients.map((recipient) => ({
							envelopeId,
							recipientId: recipient.id,
							token: crypto.randomUUID(),
							status: "active",
							expiresAt,
						})),
					)
					.returning()
			: [];
	const deliveryLinks = toDeliveryLinks(
		partnerRecipients,
		tokens.map((token) => SignerTokenSchema.parse(token)),
		sentBy,
	);
	await deliverRecipientEmails(partnerRecipients, deliveryLinks, options.emailDelivery);

	if (partnerRecipients.length > 0) {
		await db
			.insert(emailSendRecords)
			.values(
				partnerRecipients.map((recipient, index) => ({
					envelopeId,
					recipientId: recipient.id,
					tokenId: tokens[index]?.id ?? "",
					email: recipient.email,
					kind: deliveryLinks[index]?.kind ?? "partner_verification",
					fallbackUrl: deliveryLinks[index]?.url ?? "",
				})),
			)
			.returning();
	}
	await db
		.insert(auditEvents)
		.values([
			{ envelopeId, recipientId: null, eventType: "envelope.sent", message: sentBy },
			...partnerRecipients.map((recipient) => ({
				envelopeId,
				recipientId: recipient.id,
				eventType: "partner.verification.sent",
				message: recipient.email,
			})),
		])
		.returning();

	await db
		.update(envelopes)
		.set({ status: "sent", sentBy, sentAt: new Date() })
		.where(eq(envelopes.id, envelopeId));
	await Promise.all(
		partnerRecipients.map((recipient) =>
			db
				.update(envelopeRecipients)
				.set({ status: "sent" })
				.where(eq(envelopeRecipients.id, recipient.id)),
		),
	);

	return {
		envelopeId,
		status: "sent",
		sentBy,
		tokenCount: tokens.length,
		emailSendCount: partnerRecipients.length,
		verificationLinks: toPublicLinks(deliveryLinks),
	};
}

async function getExistingSendResult(
	envelopeId: string,
	sentBy: string,
): Promise<SendEnvelopeResult> {
	const db = getDb();
	const recipients = (
		await db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, envelopeId))
			.limit(10)
	).map((recipient) => RecipientSchema.parse(recipient));
	const tokens = (
		await db.select().from(signerTokens).where(eq(signerTokens.envelopeId, envelopeId)).limit(100)
	)
		.map((token) => SignerTokenSchema.parse(token))
		.filter((token) => token.status === "active");
	const sends = await db
		.select()
		.from(emailSendRecords)
		.where(eq(emailSendRecords.envelopeId, envelopeId))
		.limit(100);

	return {
		envelopeId,
		status: "sent",
		sentBy,
		tokenCount: tokens.length,
		emailSendCount: sends.length,
		verificationLinks: toPublicLinks(toDeliveryLinks(recipients, tokens, sentBy)),
	};
}

async function completeSenderRecipients(input: {
	envelopeId: string;
	sentBy: string;
	senderRecipients: Recipient[];
	fields: EnvelopeField[];
	issuedAt: Date;
}): Promise<void> {
	if (input.senderRecipients.length === 0) return;
	const senderIds = new Set(input.senderRecipients.map((recipient) => recipient.id));
	if (
		input.fields.some(
			(field) =>
				senderIds.has(field.recipientId) &&
				(field.isPlaceholder || (field.type !== "signature" && field.type !== "date")),
		)
	) {
		throw new Error("Sender custom fields require explicit completion");
	}
	const db = getDb();
	const signatureValue = await getSenderSignatureValue(input.sentBy);
	const completedAt = input.issuedAt.toISOString().slice(0, 10);

	for (const recipient of input.senderRecipients) {
		const recipientFields = input.fields.filter((field) => field.recipientId === recipient.id);
		const values = recipientFields.map((field) => ({
			envelopeId: input.envelopeId,
			recipientId: recipient.id,
			fieldId: field.id,
			value: field.type === "signature" ? signatureValue : completedAt,
		}));
		if (values.length > 0) {
			await db.insert(fieldValues).values(values).returning();
		}
		await db
			.insert(auditEvents)
			.values([
				...recipientFields.map((field) => ({
					envelopeId: input.envelopeId,
					recipientId: recipient.id,
					eventType: "field.value.completed",
					message: field.type === "signature" ? signatureValue : completedAt,
				})),
				{
					envelopeId: input.envelopeId,
					recipientId: recipient.id,
					eventType: "sender.completed",
					message: input.sentBy,
				},
			])
			.returning();
		await db
			.update(envelopeRecipients)
			.set({ status: "completed" })
			.where(eq(envelopeRecipients.id, recipient.id));
	}
}

async function getSenderSignatureValue(sentBy: string): Promise<string> {
	const db = getDb();
	const profiles = (
		await db
			.select()
			.from(signatureProfiles)
			.where(eq(signatureProfiles.createdBy, sentBy))
			.limit(100)
	).map((profile) => SignatureProfileSchema.parse(profile));
	const selectedProfile = latestSelectedProfile(profiles, sentBy);
	if (!selectedProfile) throw new Error("Sender signature profile required");
	if (selectedProfile.kind === "typed") return selectedProfile.typedText ?? selectedProfile.label;
	return selectedProfile.svgPath ?? selectedProfile.label;
}

function latestSelectedProfile(
	profiles: SignatureProfile[],
	createdBy: string,
): SignatureProfile | null {
	return (
		profiles
			.filter((profile) => profile.createdBy === createdBy && profile.selected)
			.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null
	);
}

export async function resendInvitation(
	envelopeId: string,
	recipientId: string,
	options: EnvelopeDeliveryOptions = {},
): Promise<ResendInvitationResult> {
	const db = getDb();
	const recipients = (
		await db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, envelopeId))
			.limit(10)
	).map((recipient) => RecipientSchema.parse(recipient));
	const recipient = recipients.find((candidate) => candidate.id === recipientId);
	if (!recipient) throw new Error("Recipient not found");

	const [token] = await db
		.insert(signerTokens)
		.values([
			{
				envelopeId,
				recipientId,
				token: crypto.randomUUID(),
				status: "active",
				expiresAt: new Date(Date.now() + partnerVerificationTtlMs),
			},
		])
		.returning();
	if (!token) throw new Error("Failed to create signer token");
	const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, envelopeId)).limit(1);
	const directSigning = isSenderRecipient(recipient, envelope?.sentBy ?? envelope?.createdBy ?? "");
	const fallbackUrl = directSigning
		? buildSigningUrl(token.token)
		: buildPartnerVerificationUrl(token.token);
	await deliverRecipientEmails(
		[recipient],
		[
			{
				recipientId,
				email: recipient.email,
				token: token.token,
				url: fallbackUrl,
				expiresAt: token.expiresAt.toISOString(),
				kind: directSigning ? "sender_signing" : "partner_verification",
			},
		],
		options.emailDelivery,
	);

	await db
		.insert(emailSendRecords)
		.values([
			{
				envelopeId,
				recipientId,
				tokenId: token.id,
				email: recipient.email,
				kind: "resend",
				fallbackUrl,
			},
		])
		.returning();

	const sends = await db
		.select()
		.from(emailSendRecords)
		.where(eq(emailSendRecords.recipientId, recipientId))
		.limit(100);
	return {
		recipientId,
		email: recipient.email,
		emailSendCount: sends.length,
	};
}

function buildPartnerVerificationUrl(token: string): string {
	return `/signing-verifications/${token}`;
}

function buildSigningUrl(token: string): string {
	return `/signing/${token}`;
}

function toDeliveryLinks(
	recipients: Recipient[],
	tokens: SignerToken[],
	sentBy: string,
): DeliveryLink[] {
	return tokens.map((token) => {
		const recipient = recipients.find((candidate) => candidate.id === token.recipientId);
		if (!recipient) throw new Error("Sent envelope missing token recipient");
		const kind = isSenderRecipient(recipient, sentBy) ? "sender_signing" : "partner_verification";
		return {
			recipientId: recipient.id,
			email: recipient.email,
			token: token.token,
			url:
				kind === "sender_signing"
					? buildSigningUrl(token.token)
					: buildPartnerVerificationUrl(token.token),
			expiresAt: token.expiresAt.toISOString(),
			kind,
		};
	});
}

function toPublicLinks(deliveryLinks: DeliveryLink[]): SendEnvelopeResult["verificationLinks"] {
	return deliveryLinks.map(({ kind: _kind, ...link }) => link);
}

async function deliverRecipientEmails(
	recipients: Recipient[],
	verificationLinks: DeliveryLink[],
	options: EmailDeliveryOptions | undefined,
): Promise<void> {
	if (!options || !isResendConfigured(options.env)) return;

	await Promise.all(
		recipients.map((recipient) => {
			const link = verificationLinks.find((candidate) => candidate.recipientId === recipient.id);
			if (!link) throw new Error("Sent envelope missing partner verification link");
			if (link.kind === "sender_signing") {
				return deliverTransactionalEmail(
					buildSenderSigningEmail({
						email: recipient.email,
						senderName: recipient.name,
						signingUrl: toAbsoluteDeliveryUrl(link.url, options),
					}),
					options,
				);
			}
			return deliverTransactionalEmail(
				buildPartnerVerificationEmail({
					email: recipient.email,
					recipientName: recipient.name,
					verificationUrl: toAbsoluteDeliveryUrl(link.url, options),
				}),
				options,
			);
		}),
	);
}

function isSenderRecipient(recipient: Recipient, sentBy: string): boolean {
	return recipient.email.trim().toLowerCase() === sentBy.trim().toLowerCase();
}
