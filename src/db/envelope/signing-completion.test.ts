import { PDFDocument } from "pdf-lib";
import type { SignerToken } from "./schema";
import { completeSigning } from "./signing-completion";
import {
	auditEvents,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	sourceDocuments,
} from "./table";

const state = vi.hoisted(() => ({ rows: new Map<unknown, Array<Record<string, unknown>>>() }));

vi.mock("@/db/setup", () => ({
	getDb: () => ({
		select: () => ({
			from: (table: unknown) => ({
				where: () => ({ limit: async () => state.rows.get(table) ?? [] }),
			}),
		}),
		insert: (table: unknown) => ({
			values: (input: Record<string, unknown> | Array<Record<string, unknown>>) => ({
				returning: async () => {
					const rows = state.rows.get(table) ?? [];
					const inserted = (Array.isArray(input) ? input : [input]).map((row, index) => ({
						id: `90000000-0000-4000-8000-${String(rows.length + index + 1).padStart(12, "0")}`,
						createdAt: new Date(),
						...row,
					}));
					state.rows.set(table, [...rows, ...inserted]);
					return inserted;
				},
			}),
		}),
		update: (table: unknown) => ({
			set: (patch: Record<string, unknown>) => ({
				where: async () => {
					state.rows.set(
						table,
						(state.rows.get(table) ?? []).map((row) => ({ ...row, ...patch })),
					);
				},
			}),
		}),
	}),
}));

const envelopeId = "00000000-0000-4000-8000-000000000001";
const recipientId = "20000000-0000-4000-8000-000000000001";
const token: SignerToken = {
	id: "30000000-0000-4000-8000-000000000001",
	envelopeId,
	recipientId,
	token: "private-signer-token",
	status: "active",
	expiresAt: new Date("2026-10-28T08:00:00Z"),
	verifiedAt: new Date("2026-10-21T08:00:00Z"),
	createdAt: new Date("2026-10-21T08:00:00Z"),
};

describe("truthful signing finalization", () => {
	let bucket: R2Bucket;
	let put: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		state.rows.clear();
		state.rows.set(envelopes, [
			{
				id: envelopeId,
				status: "sent",
				signingMode: "only_me",
				createdBy: "owner@amerged.com",
				createdAt: new Date(),
			},
		]);
		state.rows.set(envelopeRecipients, [
			{
				id: recipientId,
				envelopeId,
				name: "Ada",
				email: "owner@amerged.com",
				status: "sent",
				createdAt: new Date(),
			},
		]);
		state.rows.set(envelopeFields, [
			{
				id: "40000000-0000-4000-8000-000000000001",
				envelopeId,
				recipientId,
				type: "signature",
				page: 1,
				x: 72,
				y: 600,
				width: 180,
				height: 52,
				createdAt: new Date(),
			},
			{
				id: "40000000-0000-4000-8000-000000000002",
				envelopeId,
				recipientId,
				type: "date",
				page: 1,
				x: 72,
				y: 660,
				width: 100,
				height: 32,
				createdAt: new Date(),
			},
		]);
		const pdf = await PDFDocument.create();
		pdf.addPage([612, 792]);
		const bytes = await pdf.save({ useObjectStreams: false });
		state.rows.set(sourceDocuments, [
			{
				id: "50000000-0000-4000-8000-000000000001",
				envelopeId,
				r2Key: "source-v1.pdf",
				version: 1,
				sha256: "a".repeat(64),
				byteSize: bytes.byteLength,
				contentType: "application/pdf",
				originalFilename: "contract.pdf",
				uploadedBy: "owner@amerged.com",
				uploadedAt: new Date(),
			},
		]);
		put = vi.fn().mockResolvedValue(undefined);
		bucket = {
			get: async () => ({ arrayBuffer: async () => Uint8Array.from(bytes).buffer }),
			put,
		} as unknown as R2Bucket;
	});

	it("keeps a failed last-signature PDF open and resumes without duplicating or replacing recorded signatures", async () => {
		put.mockRejectedValueOnce(new Error("storage unavailable"));
		await expect(
			completeSigning(
				token,
				{ signatureName: "Ada", rememberSignature: false },
				{ documentsBucket: bucket },
			),
		).rejects.toMatchObject({ code: "FINAL_PDF_GENERATION_FAILED", retryable: true });
		expect(state.rows.get(envelopes)?.[0]?.status).toBe("sent");
		expect(state.rows.get(envelopeRecipients)?.[0]?.status).toBe("completed");
		expect(state.rows.get(fieldValues)).toHaveLength(2);
		expect(state.rows.get(auditEvents)).toHaveLength(2);
		expect(state.rows.get(finalDocuments)).toBeUndefined();

		await expect(
			completeSigning(
				token,
				{ signatureName: "Someone Else", rememberSignature: false },
				{ documentsBucket: bucket },
			),
		).rejects.toThrow("not open for completion");
		await expect(
			completeSigning(
				token,
				{ signatureName: "Ada", rememberSignature: false },
				{ documentsBucket: bucket },
			),
		).resolves.toMatchObject({ envelopeStatus: "completed" });
		expect(state.rows.get(fieldValues)).toHaveLength(2);
		expect(state.rows.get(auditEvents)).toHaveLength(2);
		expect(state.rows.get(finalDocuments)).toHaveLength(1);
		expect(state.rows.get(envelopes)?.[0]?.status).toBe("completed");
		expect(put.mock.calls[0]?.[0]).toBe(put.mock.calls[1]?.[0]);
	});

	it("does not report completion when private document storage is unavailable", async () => {
		await expect(
			completeSigning(token, { signatureName: "Ada", rememberSignature: false }),
		).rejects.toMatchObject({ code: "FINAL_PDF_GENERATION_FAILED" });
		expect(state.rows.get(envelopes)?.[0]?.status).toBe("sent");
	});
});
