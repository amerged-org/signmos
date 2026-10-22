import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { PDFDocument } from "pdf-lib";
import { withDatabase } from "@/db/setup";
import { getContract, getContractFinalPdf, listContracts } from "./contracts";
import { createAndSendClaimedContract } from "./contracts-create";
import type { CreateContractRequest } from "./contracts-schema";
import { setOmhMailTransport } from "./mail";

const owner = "owner@example.com";
const envelopeId = "a0000000-0000-4000-8000-000000000001";
const tokenId = "a0000000-0000-4000-8000-000000000002";
const commandId = "a0000000-0000-4000-8000-000000000003";
let postgres: PGlite;
let calls: { query: number; transaction: number };
let batches: readonly CustomerDatabaseQuery[][];

function wireResult(result: Results) {
	return {
		command: result.command ?? "SELECT",
		rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length,
		rows: JSON.parse(JSON.stringify(result.rows)) as Record<string, unknown>[],
	};
}

function sqlFailure(error: unknown) {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
		return { type: "ohmyhost.database-error/v1", sqlstate: error.code };
	throw error;
}

const binding: CustomerDatabaseBinding = {
	query: async (raw) => {
		calls.query += 1;
		const query = raw as CustomerDatabaseQuery;
		try {
			return wireResult(await postgres.query(query.text, [...query.values]));
		} catch (error) {
			return sqlFailure(error);
		}
	},
	transaction: async (raw) => {
		calls.transaction += 1;
		const queries = raw as CustomerDatabaseQuery[];
		batches = [...batches, queries];
		try {
			return await postgres.transaction(async (transaction) => {
				const results = [];
				for (const query of queries)
					results.push(wireResult(await transaction.query(query.text, [...query.values])));
				return results;
			});
		} catch (error) {
			return sqlFailure(error);
		}
	},
};

beforeAll(async () => {
	postgres = new PGlite();
	const migrations = new URL("../../database/omh-migrations/", import.meta.url);
	for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort())
		await postgres.exec(await readFile(new URL(file, migrations), "utf8"));
}, 20_000);
afterAll(async () => {
	await postgres.close();
});
beforeEach(async () => {
	await postgres.exec("TRUNCATE envelopes,agentic_api_tokens CASCADE");
	calls = { query: 0, transaction: 0 };
	batches = [];
});
afterEach(() => setOmhMailTransport(null));

it("executes one owner-scoped projection RPC with real SQL correlation and latest immutable artifacts", async () => {
	await postgres.query(
		"INSERT INTO envelopes(id,created_by,status) VALUES($1,$2,'completed'),($3,'another@example.com','completed')",
		[envelopeId, owner, tokenId],
	);
	await postgres.query(
		"INSERT INTO envelope_recipients(envelope_id,name,email,status) VALUES($1,'Recipient','recipient@example.com','completed')",
		[envelopeId],
	);
	await postgres.query(
		"INSERT INTO source_documents(envelope_id,r2_key,version,sha256,byte_size,content_type,original_filename,uploaded_by) VALUES($1,'source/v1.pdf',1,repeat('a',64),1,'application/pdf','Old.pdf',$2),($1,'source/v2.pdf',2,repeat('b',64),1,'application/pdf','Latest.pdf',$2)",
		[envelopeId, owner],
	);
	await postgres.query(
		"INSERT INTO final_documents(envelope_id,r2_key,sha256,byte_size,content_type,created_at) VALUES($1,'final/old.pdf',repeat('c',64),1,'application/pdf','2026-10-20T10:00:00Z'),($1,'final/new.pdf',repeat('d',64),1,'application/pdf','2026-10-21T10:00:00Z')",
		[envelopeId],
	);
	await withDatabase({ OHMYHOST_DATABASE: binding }, async () => {
		const detail = await getContract(owner, envelopeId);
		expect(detail).toMatchObject({
			title: "Latest",
			completedAt: "2026-10-21T10:00:00.000Z",
			recipients: [{ email: "recipient@example.com" }],
		});
		expect(await listContracts(owner)).toHaveLength(1);
		expect(await getContractFinalPdf(owner, envelopeId)).toEqual({
			state: "ready",
			r2Key: "final/new.pdf",
		});
		expect(await getContract(`${owner}' OR 1=1 --`, envelopeId)).toBeNull();
		expect(await getContractFinalPdf(owner, tokenId)).toEqual({ state: "not_found" });
		await postgres.query(
			"INSERT INTO audit_events(envelope_id,event_type,message) VALUES($1,'envelope.deletion_started',$2)",
			[envelopeId, owner],
		);
		expect(await getContractFinalPdf(owner, envelopeId)).toEqual({ state: "not_found" });
		expect(await getContract(owner, envelopeId)).toMatchObject({
			status: "completed",
			completedAt: null,
			downloadUrl: null,
		});
	});
	expect(calls).toEqual({ query: 7, transaction: 0 });
});

it.each([
	"success",
	"lifecycle",
	"owner",
	"command",
	"deletion",
] as const)("runs creation batches and rejects a real SQL %s race atomically", async (outcome) => {
	await postgres.query(
		"INSERT INTO agentic_api_tokens(id,email,name,token_hash,token_hint) VALUES($1,$2,'Fixture',repeat('a',64),'fixture')",
		[tokenId, owner],
	);
	await postgres.query(
		"INSERT INTO agentic_command_records(id,token_id,idempotency_key,operation,request_fingerprint) VALUES($1,$2,'fixture-create','contracts.create-and-send',repeat('b',64))",
		[commandId, tokenId],
	);
	const pdf = await PDFDocument.create();
	pdf.addPage([612, 792]);
	const request: CreateContractRequest = {
		title: "Test only",
		recipient: { name: "Recipient", email: "recipient@example.com" },
		pdf: { filename: "test.pdf", base64: Buffer.from(await pdf.save()).toString("base64") },
		fields: Array.from({ length: 20 }, (_, index) => ({
			type: index === 0 ? "signature" : "date",
			page: 1,
			x: 72,
			y: 50 + index * 25,
			width: 200,
			height: 20,
		})),
	};
	let uploaded = false;
	const documentsBucket = {
		put: async (key: string) => {
			const manifest = await postgres.query(
				"SELECT r2_key FROM envelope_artifact_versions WHERE r2_key=$1",
				[key],
			);
			expect(manifest.rows).toHaveLength(1);
			expect((await postgres.query("SELECT status FROM signer_tokens")).rows).toEqual([
				{ status: "revoked" },
			]);
			uploaded = true;
			return null;
		},
	} as unknown as R2Bucket;
	setOmhMailTransport(async () => {
		expect(uploaded).toBe(true);
		if (outcome === "lifecycle") await postgres.exec("UPDATE envelopes SET status='declined'");
		if (outcome === "owner")
			await postgres.exec("UPDATE envelopes SET created_by='another@example.com'");
		if (outcome === "command")
			await postgres.query(
				"UPDATE agentic_command_records SET state='completed',response_status=409,response_body='{}' WHERE id=$1",
				[commandId],
			);
		if (outcome === "deletion")
			await postgres.exec(
				"INSERT INTO audit_events(envelope_id,event_type,message) SELECT id,'envelope.deletion_started','owner@example.com' FROM envelopes",
			);
		return Response.json(
			{
				state: "accepted",
				request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
				message_id: "fixture-message",
			},
			{ status: 202 },
		);
	});
	const emailEnv = {
		OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		OHMYHOST_MAIL_GATEWAY_URL: "https://private-mail.example.com",
		OHMYHOST_MAIL_KEY: "m".repeat(43),
		SIGN_FROM_EMAIL: "contracts@mail.example.com",
		SIGN_REPLY_TO_EMAIL: owner,
	};
	const creating = withDatabase({ OHMYHOST_DATABASE: binding }, () =>
		createAndSendClaimedContract({
			recordId: commandId,
			email: owner,
			request,
			documentsBucket,
			emailDelivery: { env: emailEnv, baseUrl: "https://sign.example.com" },
		}),
	);
	if (outcome === "success") {
		await expect(creating).resolves.toMatchObject({
			status: "sent",
			recipients: [{ email: request.recipient.email, status: "sent" }],
		});
		expect((await postgres.query("SELECT status FROM signer_tokens")).rows).toEqual([
			{ status: "active" },
		]);
		const command = (
			await postgres.query(
				"SELECT response_status,response_body,document_id FROM agentic_command_records WHERE id=$1",
				[commandId],
			)
		).rows[0];
		expect(command).toMatchObject({ response_status: 201, document_id: expect.any(String) });
	} else {
		await expect(creating).rejects.toThrow();
		expect((await postgres.query("SELECT status FROM signer_tokens")).rows).toEqual([
			{ status: "revoked" },
		]);
		expect(
			(await postgres.query("SELECT count(*)::integer AS count FROM email_send_records")).rows,
		).toEqual([{ count: 0 }]);
		expect((await postgres.query("SELECT status FROM envelopes")).rows[0]).not.toEqual({
			status: "sent",
		});
	}
	expect(calls).toEqual({ query: 0, transaction: 2 });
	expect(batches.flat().every((query) => query.values.length <= 100)).toBe(true);
});
