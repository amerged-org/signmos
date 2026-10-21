import {
	auditEvents,
	completeSigning,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	type SignerToken,
	signatureProfiles,
} from "@/db/envelope";

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	recipientsTable: null as unknown,
	fieldsTable: null as unknown,
	fieldValuesTable: null as unknown,
	auditEventsTable: null as unknown,
	emailSendRecordsTable: null as unknown,
	signatureProfilesTable: null as unknown,
	envelopes: [] as Array<Record<string, unknown>>,
	recipients: [] as Array<Record<string, unknown>>,
	fields: [] as Array<Record<string, unknown>>,
	fieldValues: [] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
	emailSends: [] as Array<Record<string, unknown>>,
	signatureProfiles: [] as Array<Record<string, unknown>>,
}));

function selectRows(table: unknown): Array<Record<string, unknown>> {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.fieldsTable) return state.fields;
	if (table === state.fieldValuesTable) return state.fieldValues;
	if (table === state.emailSendRecordsTable) return state.emailSends;
	if (table === state.signatureProfilesTable) return state.signatureProfiles;
	return [];
}

function insertRows(
	table: unknown,
	rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	if (table === state.fieldValuesTable) {
		state.fieldValues.push(...rows);
		return rows;
	}
	if (table === state.auditEventsTable) {
		state.auditEvents.push(...rows);
		return rows;
	}
	if (table === state.emailSendRecordsTable) {
		state.emailSends.push(...rows);
		return rows;
	}
	if (table === state.signatureProfilesTable) {
		const inserted = rows.map((row, index) => ({
			id: `60000000-0000-4000-8000-${String(state.signatureProfiles.length + index + 1).padStart(12, "0")}`,
			createdAt: new Date("2026-05-22T08:00:00.000Z"),
			...row,
		}));
		state.signatureProfiles.push(...inserted);
		return inserted;
	}
	return [];
}

vi.mock("@/db/setup", async () => {
	const { wrapSigningTestDb } = await import("@/db/envelope/signing-test-db");
	return {
		getDb: () =>
			wrapSigningTestDb(
				{
					select: () => ({
						from: (table: unknown) => ({
							where: () => ({
								limit: async () => selectRows(table),
							}),
						}),
					}),
					insert: (table: unknown) => ({
						values: (rows: Array<Record<string, unknown>> | Record<string, unknown>) => ({
							returning: async () => insertRows(table, Array.isArray(rows) ? rows : [rows]),
						}),
					}),
					update: (table: unknown) => ({
						set: (value: { status?: string }) => ({
							where: async () => {
								if (table === state.recipientsTable) {
									state.recipients[0] = { ...state.recipients[0], status: value.status ?? "sent" };
								}
								if (table === state.envelopesTable) {
									state.envelopes[0] = { ...state.envelopes[0], status: value.status ?? "sent" };
								}
								return [];
							},
						}),
					}),
				},
				selectRows,
			),
	};
});

describe("completeSigning signature profile reuse", () => {
	beforeEach(() => {
		state.envelopesTable = envelopes;
		state.recipientsTable = envelopeRecipients;
		state.fieldsTable = envelopeFields;
		state.fieldValuesTable = fieldValues;
		state.auditEventsTable = auditEvents;
		state.emailSendRecordsTable = emailSendRecords;
		state.signatureProfilesTable = signatureProfiles;
		state.envelopes = [
			{
				id: "00000000-0000-4000-8000-000000000001",
				status: "sent",
				signingMode: "me_and_another_signer",
				createdBy: "sender@example.com",
				createdAt: new Date("2026-05-22T07:00:00.000Z"),
				sentBy: "sender@example.com",
				sentAt: new Date("2026-05-22T07:04:00.000Z"),
			},
		];
		state.recipients = [
			{
				id: "20000000-0000-4000-8000-000000000001",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Ada Lovelace",
				email: "ADA@Example.COM",
				status: "sent",
				createdAt: new Date("2026-05-22T07:02:00.000Z"),
			},
			{
				id: "20000000-0000-4000-8000-000000000002",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Grace Hopper",
				email: "grace@example.com",
				status: "sent",
				createdAt: new Date("2026-05-22T07:02:00.000Z"),
			},
		];
		state.fields = [
			{
				id: "50000000-0000-4000-8000-000000000001",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000001",
				type: "signature",
				page: 1,
				x: 72,
				y: 144,
				width: 180,
				height: 48,
				createdAt: new Date("2026-05-22T07:05:00.000Z"),
			},
		];
		state.fieldValues = [];
		state.auditEvents = [];
		state.emailSends = [];
		state.signatureProfiles = [
			{
				id: "60000000-0000-4000-8000-000000000001",
				envelopeId: "00000000-0000-4000-8000-000000000099",
				createdBy: "ada@example.com",
				kind: "typed",
				label: "Saved typed",
				svgPath: null,
				typedText: "Ada Saved",
				typedFont: "serif",
				selected: true,
				createdAt: new Date("2026-05-21T08:00:00.000Z"),
			},
		];
	});

	it("stores changed signing content as the latest reusable profile for the normalized email", async () => {
		await completeSigning(
			verifiedToken,
			{
				signature: {
					kind: "drawn",
					label: "Ada updated drawn",
					svgPath: "M 12 36 L 48 20 L 96 42",
				},
				rememberSignature: true,
			},
			{ now: new Date("2026-05-22T08:00:00.000Z") },
		);

		expect(state.signatureProfiles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					createdBy: "ada@example.com",
					kind: "drawn",
					label: "Ada updated drawn",
					svgPath: "M 12 36 L 48 20 L 96 42",
					typedText: null,
					typedFont: null,
					selected: true,
				}),
			]),
		);
	});
});

const verifiedToken = {
	id: "30000000-0000-4000-8000-000000000001",
	envelopeId: "00000000-0000-4000-8000-000000000001",
	recipientId: "20000000-0000-4000-8000-000000000001",
	token: "valid-token",
	status: "active",
	expiresAt: new Date("2026-05-29T07:03:00.000Z"),
	verifiedAt: new Date("2026-05-22T07:04:00.000Z"),
	createdAt: new Date("2026-05-22T07:03:00.000Z"),
} satisfies SignerToken;
