import { PDFDocument } from "pdf-lib";
import { envelopeArtifactVersions } from "./artifact-versions";
import { controlEnvelope } from "./controls";
import { finalizeCompletedEnvelope, regenerateFinalDocumentArtifact } from "./finalization";
import type { FinalDocument, SourceDocument } from "./schema";
import { envelopes, finalDocuments, sourceDocuments } from "./table";

const dbState = vi.hoisted(() => ({
	rows: new Map<unknown, Array<Record<string, unknown>>>(),
	updates: [] as Array<Record<string, unknown>>,
	failNextUpdate: false,
}));

vi.mock("@/db/setup", async () => {
	const { wrapSigningTestDb } = await import("@/db/envelope/signing-test-db");
	return {
		getDb: () =>
			wrapSigningTestDb(
				{
					select: () => ({
						from: (table: unknown) => ({
							where: () => ({ limit: async () => dbState.rows.get(table) ?? [] }),
						}),
					}),
					insert: (table: unknown) => ({
						values: (row: Record<string, unknown>) => ({
							returning: async () => {
								const inserted = {
									id: "90000000-0000-4000-8000-000000000001",
									createdAt: new Date("2026-10-21T09:00:00Z"),
									...row,
								};
								const records = dbState.rows.get(table) ?? [];
								records.push(inserted);
								dbState.rows.set(table, records);
								return [inserted];
							},
						}),
					}),
					update: (table: unknown) => ({
						set: (patch: Record<string, unknown>) => ({
							where: async () => {
								if (dbState.failNextUpdate) {
									dbState.failNextUpdate = false;
									throw new Error("database unavailable");
								}
								dbState.updates.push(patch);
								const records = dbState.rows.get(table) ?? [];
								dbState.rows.set(
									table,
									records.map((row) => ({ ...row, ...patch })),
								);
							},
						}),
					}),
				},
				(table) => dbState.rows.get(table) ?? [],
			),
	};
});

const envelopeId = "00000000-0000-4000-8000-000000000001";

describe("immutable final document artifacts", () => {
	let objects: Map<string, Uint8Array>;
	let bucket: R2Bucket;
	let writtenKeys: string[];

	beforeEach(async () => {
		dbState.rows.clear();
		dbState.rows.set(envelopes, [
			{
				id: envelopeId,
				status: "completed",
				signingMode: "only_me",
				createdBy: "owner@amerged.com",
				createdAt: new Date(),
			},
		]);
		dbState.updates.length = 0;
		dbState.failNextUpdate = false;
		const pdf = await PDFDocument.create();
		pdf.addPage([612, 792]);
		const bytes = await pdf.save({ useObjectStreams: false });
		const source: SourceDocument = {
			id: "10000000-0000-4000-8000-000000000001",
			envelopeId,
			r2Key: `envelopes/${envelopeId}/source-v1.pdf`,
			version: 1,
			sha256: "a".repeat(64),
			byteSize: bytes.byteLength,
			contentType: "application/pdf",
			originalFilename: "contract.pdf",
			uploadedBy: "owner@amerged.com",
			uploadedAt: new Date("2026-10-21T08:00:00Z"),
		};
		dbState.rows.set(sourceDocuments, [source]);
		objects = new Map([[source.r2Key, bytes]]);
		writtenKeys = [];
		bucket = {
			get: async (key: string) => {
				const content = objects.get(key);
				return content ? { arrayBuffer: async () => Uint8Array.from(content).buffer } : null;
			},
			put: async (key: string, content: Uint8Array) => {
				const existing = objects.get(key);
				if (existing && !Buffer.from(existing).equals(content))
					throw new Error("immutable storage conflict");
				objects.set(key, Uint8Array.from(content));
				writtenKeys.push(key);
			},
		} as unknown as R2Bucket;
	});

	it("uses a new version locator when repairing and leaves the original contract intact", async () => {
		const legacy = oldFinalDocument();
		const legacyBytes = new TextEncoder().encode("legacy final artifact");
		objects.set(legacy.r2Key, legacyBytes);
		dbState.rows.set(finalDocuments, [legacy]);

		const regenerated = await regenerateFinalDocumentArtifact(legacy, { documentsBucket: bucket });
		expect(regenerated?.document.r2Key).toMatch(
			new RegExp(`^envelopes/${envelopeId}/final/[a-f0-9]{64}-[a-f0-9-]{36}\\.pdf$`),
		);
		expect(regenerated?.document.r2Key).not.toBe(legacy.r2Key);
		expect(dbState.updates[0]?.r2Key).toBe(regenerated?.document.r2Key);
		expect(objects.get(legacy.r2Key)).toEqual(legacyBytes);
		expect(objects.get(regenerated?.document.r2Key ?? "")).toEqual(regenerated?.bytes);
		expect([...objects.keys()]).toContain(`envelopes/${envelopeId}/source-v1.pdf`);
	});

	it("stores a retry under a name of its own after an upload succeeds but the database update fails", async () => {
		const legacy = oldFinalDocument();
		dbState.rows.set(finalDocuments, [legacy]);
		dbState.failNextUpdate = true;
		await expect(
			regenerateFinalDocumentArtifact(legacy, { documentsBucket: bucket }),
		).rejects.toThrow("database unavailable");
		const retried = await regenerateFinalDocumentArtifact(legacy, { documentsBucket: bucket });
		// The platform may have let the first reservation die, so the retry never replays its name.
		// Both names are retained, and the record points at the retry's.
		expect(writtenKeys).toHaveLength(2);
		expect(writtenKeys[0]).not.toBe(writtenKeys[1]);
		expect(retried?.document.r2Key).toBe(writtenKeys[1]);
		expect(
			new Set((dbState.rows.get(envelopeArtifactVersions) ?? []).map((row) => row.r2Key)),
		).toEqual(new Set([legacy.r2Key, writtenKeys[0], writtenKeys[1]]));
	});

	it("does not create another artifact when finalization is retried after commit", async () => {
		const first = await finalizeCompletedEnvelope(envelopeId, { documentsBucket: bucket });
		const retried = await finalizeCompletedEnvelope(envelopeId, { documentsBucket: bucket });
		expect(retried).toEqual(first);
		expect(writtenKeys).toEqual([first?.r2Key]);
		expect(first?.r2Key).toMatch(/\/final\/[a-f0-9]{64}-[a-f0-9-]{36}\.pdf$/);
		expect(dbState.rows.get(finalDocuments)).toHaveLength(1);
	});

	it("cannot store or advertise a final PDF when the retained source is unreadable", async () => {
		objects.set(`envelopes/${envelopeId}/source-v1.pdf`, new TextEncoder().encode("corrupt PDF"));
		await expect(
			finalizeCompletedEnvelope(envelopeId, { documentsBucket: bucket }),
		).rejects.toMatchObject({ code: "INVALID_SOURCE_PDF" });
		expect(writtenKeys).toEqual([]);
		expect(dbState.rows.get(finalDocuments)).toBeUndefined();
	});

	it("deletes every retained final version and only marks the envelope deleted after erasure completes", async () => {
		const legacy = oldFinalDocument();
		dbState.rows.set(envelopes, [
			{
				id: envelopeId,
				status: "completed",
				signingMode: "only_me",
				createdBy: "owner@amerged.com",
				createdAt: new Date(),
			},
		]);
		dbState.rows.set(finalDocuments, [legacy]);
		const regenerated = await regenerateFinalDocumentArtifact(legacy, { documentsBucket: bucket });
		const retainedVersions = dbState.rows.get(envelopeArtifactVersions) ?? [];
		expect(retainedVersions.map((row) => row.r2Key)).toEqual([
			legacy.r2Key,
			regenerated?.document.r2Key,
		]);
		const erase = vi
			.fn()
			.mockRejectedValueOnce(new Error("deletion pending"))
			.mockResolvedValueOnce(undefined);
		bucket.delete = erase;

		await expect(
			controlEnvelope(envelopeId, "owner@amerged.com", "delete", { documentsBucket: bucket }),
		).rejects.toThrow("deletion pending");
		expect(dbState.rows.get(envelopes)?.[0]?.status).toBe("completed");
		await expect(
			controlEnvelope(envelopeId, "owner@amerged.com", "delete", { documentsBucket: bucket }),
		).resolves.toMatchObject({ status: "deleted" });
		const keys = erase.mock.calls[0]?.[0];
		expect(keys).toHaveLength(3);
		expect(keys).toEqual(
			expect.arrayContaining([
				legacy.r2Key,
				regenerated?.document.r2Key,
				`envelopes/${envelopeId}/source-v1.pdf`,
			]),
		);
		expect(erase.mock.calls[1]?.[0]).toEqual(keys);
	});
});

function oldFinalDocument(): FinalDocument {
	return {
		id: "90000000-0000-4000-8000-000000000001",
		envelopeId,
		r2Key: `envelopes/${envelopeId}/final.pdf`,
		sha256: "b".repeat(64),
		byteSize: 19,
		contentType: "application/pdf",
		createdAt: new Date("2026-10-21T08:00:00Z"),
	};
}
