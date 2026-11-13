import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { withDatabase } from "@/db/setup";
import { processContractInvitations, retryContractInvitations } from "./contracts-outbox";

let database: PGlite;
let calls: number;
let keys: string[];
let uncertain: boolean;
let lostReceipt: boolean;
const owner = "owner@example.com";
const env = {
	OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	OHMYHOST_MAIL_GATEWAY_URL: "https://mail.example.com",
	OHMYHOST_MAIL_KEY: "m".repeat(43),
};

function result(value: Results) {
	return {
		command: value.command ?? "SELECT",
		rowCount: value.rowCount ?? value.affectedRows ?? value.rows.length,
		rows: JSON.parse(JSON.stringify(value.rows)) as Record<string, unknown>[],
	};
}
function failure(error: unknown) {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
		return { type: "ohmyhost.database-error/v1", sqlstate: error.code };
	throw error;
}
const binding: CustomerDatabaseBinding = {
	query: async (raw) => {
		calls++;
		const query = raw as CustomerDatabaseQuery;
		try {
			return result(await database.query(query.text, [...query.values]));
		} catch (error) {
			return failure(error);
		}
	},
	transaction: async (raw) => {
		calls++;
		try {
			const values = await database.transaction(async (transaction) => {
				const values = [];
				for (const query of raw as CustomerDatabaseQuery[])
					values.push(result(await transaction.query(query.text, [...query.values])));
				return values;
			});
			if (lostReceipt) {
				lostReceipt = false;
				throw new Error("Receipt lost after commit");
			}
			return values;
		} catch (error) {
			return failure(error);
		}
	},
};
const scoped = <T>(callback: () => Promise<T>) =>
	withDatabase({ OHMYHOST_DATABASE: binding }, callback);

beforeAll(async () => {
	database = new PGlite();
	const directory = new URL("../../database/omh-migrations/", import.meta.url);
	for (const name of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort())
		await database.exec(await readFile(new URL(name, directory), "utf8"));
}, 20_000);
afterAll(async () => database.close());
beforeEach(() => {
	calls = 0;
	keys = [];
	uncertain = false;
	lostReceipt = false;
	vi.stubGlobal("fetch", async (request: Request) => {
		calls++;
		keys.push(request.headers.get("idempotency-key") ?? "missing");
		return Response.json(
			uncertain
				? { state: "uncertain", request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW" }
				: { state: "accepted", request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", message_id: "message-1" },
			{ status: 202 },
		);
	});
});
afterEach(() => vi.unstubAllGlobals());

async function fixture(count: number) {
	const envelope = crypto.randomUUID();
	await database.query("INSERT INTO envelopes(id,created_by,status) VALUES ($1,$2,'queued')", [
		envelope,
		owner,
	]);
	for (let index = 0; index < count; index++) {
		const recipient = crypto.randomUUID();
		const token = crypto.randomUUID();
		const job = crypto.randomUUID();
		const email = `recipient${index}@example.com`;
		await database.query(
			"INSERT INTO envelope_recipients(id,envelope_id,name,email,status) VALUES ($1,$2,'Recipient',$3,'pending')",
			[recipient, envelope, email],
		);
		await database.query(
			"INSERT INTO signer_tokens(id,envelope_id,recipient_id,token,status,expires_at) VALUES ($1,$2,$3,$4,'revoked',now()+interval '7 days')",
			[token, envelope, recipient, crypto.randomUUID()],
		);
		await database.query(
			`INSERT INTO contract_invitation_outbox(id,envelope_id,recipient_id,token_id,status,to_email,from_email,subject,text_body,html_body,verification_url)
			VALUES ($1,$2,$3,$4,'queued',$5,'from@example.com','Subject','Body','<p>Body</p>','https://sign.example.com/signing-verifications/example')`,
			[job, envelope, recipient, token, email],
		);
	}
	return envelope;
}

it("delivers three invitations within nine calls and activates all recipients together", async () => {
	const envelope = await fixture(3);
	await scoped(() => processContractInvitations(env));
	expect(calls).toBe(9);
	expect(new Set(keys).size).toBe(3);
	const rows = await database.query<{ status: string }>(
		"SELECT status FROM contract_invitation_outbox WHERE envelope_id=$1",
		[envelope],
	);
	expect(rows.rows.map((row) => row.status)).toEqual(["delivered", "delivered", "delivered"]);
	expect(
		(
			await database.query<{ status: string }>("SELECT status FROM envelopes WHERE id=$1", [
				envelope,
			])
		).rows[0]?.status,
	).toBe("sent");
	expect(
		(
			await database.query<{ status: string }>(
				"SELECT status FROM signer_tokens WHERE envelope_id=$1",
				[envelope],
			)
		).rows.map((row) => row.status),
	).toEqual(["active", "active", "active"]);
});

it("stops on uncertain delivery, permits owner retry with the same key, and never retries after the window", async () => {
	const envelope = await fixture(1);
	uncertain = true;
	await scoped(() => processContractInvitations(env));
	expect(
		(
			await database.query<{ status: string }>(
				"SELECT status FROM signer_tokens WHERE envelope_id=$1",
				[envelope],
			)
		).rows[0]?.status,
	).toBe("revoked");
	await expect(
		scoped(() => retryContractInvitations(envelope, "other@example.com")),
	).resolves.toEqual({ requeued: 0, manualReview: 0 });
	await expect(scoped(() => retryContractInvitations(envelope, owner))).resolves.toEqual({
		requeued: 1,
		manualReview: 0,
	});
	uncertain = false;
	await scoped(() => processContractInvitations(env));
	expect(keys).toHaveLength(2);
	expect(keys[1]).toBe(keys[0]);
	const late = await fixture(1);
	await database.query(
		"UPDATE contract_invitation_outbox SET status='uncertain', first_attempt_at=now()-interval '23 hours' WHERE envelope_id=$1",
		[late],
	);
	await expect(scoped(() => retryContractInvitations(late, owner))).resolves.toEqual({
		requeued: 0,
		manualReview: 1,
	});
	expect(
		(
			await database.query<{ status: string }>(
				"SELECT status FROM contract_invitation_outbox WHERE envelope_id=$1",
				[late],
			)
		).rows[0]?.status,
	).toBe("manual_review");
});

it("does not resend after the database commits but the receipt is lost", async () => {
	const envelope = await fixture(1);
	lostReceipt = true;
	await scoped(() => processContractInvitations(env));
	expect(calls).toBe(4);
	expect(
		(
			await database.query<{ status: string }>(
				"SELECT status FROM contract_invitation_outbox WHERE envelope_id=$1",
				[envelope],
			)
		).rows[0]?.status,
	).toBe("delivered");
	await expect(scoped(() => retryContractInvitations(envelope, owner))).resolves.toEqual({
		requeued: 0,
		manualReview: 0,
	});
	await scoped(() => processContractInvitations(env));
	expect(keys).toHaveLength(1);
});
