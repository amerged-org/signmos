import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { PDFDocument } from "pdf-lib";
import { withDatabase } from "@/db/setup";
import { finalizeCompletedEnvelope, regenerateFinalDocumentArtifact } from "./finalization";

let database: PGlite;
const result = (value: Results) => ({
	command: value.command ?? "SELECT",
	rowCount: value.rows.length,
	rows: JSON.parse(JSON.stringify(value.rows)) as Record<string, unknown>[],
});
const binding: CustomerDatabaseBinding = {
	query: async (raw) => {
		const query = raw as CustomerDatabaseQuery;
		return result(await database.query(query.text, [...query.values]));
	},
	transaction: async (raw) =>
		database.transaction(async (transaction) => {
			const results = [];
			for (const query of raw as CustomerDatabaseQuery[])
				results.push(result(await transaction.query(query.text, [...query.values])));
			return results;
		}),
};
const scoped = <T>(run: () => Promise<T>) => withDatabase({ OHMYHOST_DATABASE: binding }, run);
beforeAll(async () => {
	database = new PGlite();
	const directory = new URL("../../../database/omh-migrations/", import.meta.url);
	for (const file of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort())
		await database.exec(await readFile(new URL(file, directory), "utf8"));
}, 20_000);
afterAll(async () => database.close());

async function fixture() {
	const envelope = crypto.randomUUID();
	const pdf = await PDFDocument.create();
	pdf.addPage();
	const bytes = await pdf.save();
	await database.query(
		"insert into envelopes(id,created_by,status) values ($1,'Owner@Example.com','completed')",
		[envelope],
	);
	await database.query(
		"insert into source_documents(envelope_id,r2_key,version,sha256,byte_size,content_type,original_filename,uploaded_by) values ($1,$4,1,$2,$3,'application/pdf','contract.pdf','owner@example.com')",
		[envelope, "a".repeat(64), bytes.length, `source/${envelope}`],
	);
	for (const email of ["owner@example.com", "party@example.com", "PARTY@example.com"]) {
		const recipient = crypto.randomUUID();
		await database.query(
			"insert into envelope_recipients(id,envelope_id,name,email,status) values ($1,$2,'Party',$3,'completed')",
			[recipient, envelope, email],
		);
		await database.query(
			"insert into signer_tokens(envelope_id,recipient_id,token,status,verified_at,expires_at) values ($1,$2,$3,'active',now(),now()+interval '1 minute')",
			[envelope, recipient, crypto.randomUUID()],
		);
	}
	let failUpload = false;
	const bucket = {
		get: async () => ({ arrayBuffer: async () => Uint8Array.from(bytes).buffer }),
		put: async () => {
			if (failUpload) throw new Error("upload failed");
		},
	} as unknown as R2Bucket;
	return {
		envelope,
		bucket,
		fail: () => {
			failUpload = true;
		},
	};
}
async function intents(envelope: string) {
	const exists = await database.query<{ name: string | null }>(
		"select to_regclass('contract_final_delivery_outbox')::text as name",
	);
	return exists.rows[0]?.name
		? (
				await database.query<{ to_email: string; access_path: string }>(
					"select to_email,access_path from contract_final_delivery_outbox where envelope_id=$1 order by to_email",
					[envelope],
				)
			).rows
		: [];
}
it("durably queues one secure final-version link per unique party and creator after upload", async () => {
	const { envelope, bucket } = await fixture();
	const document = await scoped(() =>
		finalizeCompletedEnvelope(envelope, { documentsBucket: bucket }),
	);
	expect(document).not.toBeNull();
	expect(await intents(envelope)).toEqual([
		{ to_email: "owner@example.com", access_path: `/my-documents/${envelope}` },
		{
			to_email: "party@example.com",
			access_path: expect.stringMatching(/^\/completed-documents\//),
		},
	]);
	await scoped(() => finalizeCompletedEnvelope(envelope, { documentsBucket: bucket }));
	expect(await intents(envelope)).toHaveLength(2);
	const tokens = await database.query<{ fresh: boolean }>(
		"select expires_at > now()+interval '6 days' as fresh from signer_tokens where envelope_id=$1",
		[envelope],
	);
	expect(tokens.rows.every((row) => row.fresh)).toBe(true);
});
it("creates no notification intent when the final PDF upload fails", async () => {
	const { envelope, bucket, fail } = await fixture();
	fail();
	await expect(
		scoped(() => finalizeCompletedEnvelope(envelope, { documentsBucket: bucket })),
	).rejects.toThrow();
	expect(await intents(envelope)).toEqual([]);
});

it("queues the committed repaired version when a final artifact is replaced", async () => {
	const { envelope, bucket } = await fixture();
	const legacy = {
		id: crypto.randomUUID(),
		envelopeId: envelope,
		r2Key: `legacy/${envelope}`,
		sha256: "b".repeat(64),
		byteSize: 20,
		contentType: "application/pdf" as const,
		createdAt: new Date(),
	};
	await database.query(
		"insert into final_documents(id,envelope_id,r2_key,sha256,byte_size,content_type) values ($1,$2,$3,$4,20,'application/pdf')",
		[legacy.id, envelope, legacy.r2Key, legacy.sha256],
	);
	const repaired = await scoped(() =>
		regenerateFinalDocumentArtifact(legacy, { documentsBucket: bucket }),
	);
	expect(repaired?.document.sha256).not.toBe(legacy.sha256);
	expect(await intents(envelope)).toHaveLength(2);
});
