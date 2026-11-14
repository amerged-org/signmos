import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { PDFDocument } from "pdf-lib";
import { withDatabase } from "@/db/setup";
import { parseDraftContract } from "./contracts-draft-schema";
import { createClaimedContractDraft, replaceClaimedContractPdf } from "./contracts-drafts";

let postgres: PGlite;
function result(value: Results) {
	return {
		command: value.command ?? "SELECT",
		rowCount: value.rowCount ?? value.affectedRows ?? value.rows.length,
		rows: JSON.parse(JSON.stringify(value.rows)) as Record<string, unknown>[],
	};
}
const binding: CustomerDatabaseBinding = {
	query: async (raw) => {
		const query = raw as CustomerDatabaseQuery;
		return result(await postgres.query(query.text, [...query.values]));
	},
	transaction: async (raw) =>
		postgres.transaction(async (transaction) => {
			const rows = [];
			for (const query of raw as CustomerDatabaseQuery[])
				rows.push(result(await transaction.query(query.text, [...query.values])));
			return rows;
		}),
};
beforeAll(async () => {
	postgres = new PGlite();
	const migrations = new URL("../../database/omh-migrations/", import.meta.url);
	for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort())
		await postgres.exec(await readFile(new URL(file, migrations), "utf8"));
}, 20_000);
afterAll(async () => postgres.close());

it("rejects the next artifact reservation at 4000 retained keys before uploading", async () => {
	const email = "owner@example.com";
	const tokenId = crypto.randomUUID();
	const createId = crypto.randomUUID();
	const replaceId = crypto.randomUUID();
	await postgres.query(
		"INSERT INTO agentic_api_tokens(id,email,name,token_hash,token_hint) VALUES($1,$2,'Fixture',repeat('a',64),'fixture')",
		[tokenId, email],
	);
	await postgres.query(
		"INSERT INTO agentic_command_records(id,token_id,idempotency_key,operation,request_fingerprint) VALUES($1,$3,'create','contracts.drafts.create',repeat('b',64)),($2,$3,'replace','contracts.pdf.replace',repeat('c',64))",
		[createId, replaceId, tokenId],
	);
	const pdf = await PDFDocument.create();
	pdf.addPage([612, 792]);
	const request = {
		title: "Draft",
		recipient: { name: "Ada", email: "ada@example.com" },
		pdf: { filename: "agreement.pdf", base64: Buffer.from(await pdf.save()).toString("base64") },
	};
	const files = new Map<string, Uint8Array>();
	const bucket = {
		put: async (key: string, bytes: Uint8Array) => {
			files.set(key, bytes);
			return null;
		},
		delete: async (key: string) => {
			files.delete(key);
		},
	} as unknown as R2Bucket;
	const contract = await withDatabase({ OHMYHOST_DATABASE: binding }, () =>
		createClaimedContractDraft({ recordId: createId, email, request, documentsBucket: bucket }),
	);
	await postgres.query(
		"INSERT INTO envelope_artifact_versions(id,envelope_id,r2_key) SELECT gen_random_uuid(),$1,'retained/'||n FROM generate_series(1,3999) AS n",
		[contract.id],
	);
	const replacement = withDatabase({ OHMYHOST_DATABASE: binding }, () =>
		replaceClaimedContractPdf({
			recordId: replaceId,
			email,
			id: contract.id,
			request,
			documentsBucket: bucket,
		}),
	);
	await expect(replacement).rejects.toMatchObject({ code: "SOURCE_VERSION_LIMIT", status: 413 });
	expect(files.size).toBe(1);
	expect(
		(
			await postgres.query(
				"SELECT count(*)::integer AS count FROM envelope_artifact_versions WHERE envelope_id=$1",
				[contract.id],
			)
		).rows,
	).toEqual([{ count: 4000 }]);
});

it("rejects unsupported definition kind values instead of treating them as PDF placeholders", () => {
	const definition = {
		title: "Draft",
		kind: "html",
		pdf: { filename: "agreement.pdf", base64: "JVBERg==" },
		recipients: [{ index: 1, name: "Ada", email: "ada@example.com" }],
		fields: [{ recipient: 1, name: "sign", type: "signature", label: "Signature", required: true }],
	};
	expect(() => parseDraftContract(definition)).toThrow();
});
