import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import * as brandedEmail from "@/lib/branded-email";
import worker from "@/ohmyhost/worker";

let database: PGlite;
let calls = 0;
let inTransaction = false;
let uncertain = false;
let loseReceipt = false;
let messages: { key: string; body: Record<string, unknown> }[];
const result = (value: Results) => ({
	command: value.command ?? "SELECT",
	rowCount: value.rowCount ?? value.affectedRows ?? value.rows.length,
	rows: JSON.parse(JSON.stringify(value.rows)) as Record<string, unknown>[],
});
const binding: CustomerDatabaseBinding = {
	query: async (raw) => {
		calls++;
		const query = raw as CustomerDatabaseQuery;
		return result(await database.query(query.text, [...query.values]));
	},
	transaction: async (raw) => {
		calls++;
		inTransaction = true;
		try {
			const values = await database.transaction(async (transaction) => {
				const results = [];
				for (const query of raw as CustomerDatabaseQuery[])
					results.push(result(await transaction.query(query.text, [...query.values])));
				return results;
			});
			if (loseReceipt) {
				loseReceipt = false;
				throw new Error("lost receipt");
			}
			return values;
		} finally {
			inTransaction = false;
		}
	},
};
const env = {
	OHMYHOST_DATABASE: binding,
	OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	OHMYHOST_MAIL_GATEWAY_URL: "https://mail.example.com",
	OHMYHOST_MAIL_KEY: "m".repeat(43),
	SIGN_FROM_EMAIL: "contracts@example.com",
	APP_BASE_URL: "https://sign.example.com",
} as unknown as Env;
const drain = () => worker.scheduled({} as ScheduledController, env);
beforeAll(async () => {
	database = new PGlite();
	const directory = new URL("../../database/omh-migrations/", import.meta.url);
	for (const file of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort())
		await database.exec(await readFile(new URL(file, directory), "utf8"));
}, 20_000);
afterAll(async () => database.close());
beforeEach(async () => {
	await database.exec(
		"truncate contract_final_delivery_outbox, contract_invitation_outbox cascade",
	);
	calls = 0;
	uncertain = false;
	loseReceipt = false;
	messages = [];
	vi.stubGlobal("fetch", async (request: Request) => {
		expect(inTransaction).toBe(false);
		calls++;
		messages.push({
			key: request.headers.get("idempotency-key") ?? "missing",
			body: (await request.json()) as Record<string, unknown>,
		});
		return Response.json(
			uncertain
				? { state: "uncertain", request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW" }
				: { state: "accepted", request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", message_id: "message-1" },
			{ status: 202 },
		);
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
async function fixture(count: number) {
	const envelope = crypto.randomUUID();
	const document = crypto.randomUUID();
	await database.query(
		"insert into envelopes(id,created_by,status) values ($1,'owner@example.com','completed')",
		[envelope],
	);
	await database.query(
		"insert into final_documents(id,envelope_id,r2_key,sha256,byte_size,content_type) values ($1,$2,$3,$4,20,'application/pdf')",
		[document, envelope, `final/${envelope}`, "b".repeat(64)],
	);
	for (let index = 0; index < count; index++)
		await database.query(
			"insert into contract_final_delivery_outbox(envelope_id,final_document_id,final_sha256,to_email,access_path) values ($1,$2,$3,$4,$5)",
			[
				envelope,
				document,
				"b".repeat(64),
				`party${index}@example.com`,
				`/completed-documents/token-${index}`,
			],
		);
	return envelope;
}
async function statuses(envelope: string) {
	return (
		await database.query<{ status: string }>(
			"select status from contract_final_delivery_outbox where envelope_id=$1 order by to_email",
			[envelope],
		)
	).rows.map((row) => row.status);
}
it("sends at most three branded final link mails within ten calls, without attachments or transaction network", async () => {
	const envelope = await fixture(4);
	await drain();
	expect(messages).toHaveLength(3);
	expect(calls).toBeLessThanOrEqual(10);
	expect((await statuses(envelope)).sort()).toEqual([
		"delivered",
		"delivered",
		"delivered",
		"queued",
	]);
	for (const message of messages) {
		expect(message.key).toMatch(/^sign\.final\./);
		expect(message.body).not.toHaveProperty("attachments");
		expect(message.body.html).toContain("amerged-logo-email.png");
		expect(message.body.text).toContain("https://sign.example.com/completed-documents/token-");
	}
});
it("recovers uncertain delivery with the exact same provider key and stored payload", async () => {
	const envelope = await fixture(1);
	uncertain = true;
	await drain();
	expect(await statuses(envelope)).toEqual(["uncertain"]);
	const frozen = (
		await database.query<{ subject: string; text_body: string; html_body: string }>(
			"select subject,text_body,html_body from contract_final_delivery_outbox where envelope_id=$1",
			[envelope],
		)
	).rows[0];
	expect(frozen).toEqual({
		subject: messages[0]?.body.subject,
		text_body: messages[0]?.body.text,
		html_body: messages[0]?.body.html,
	});
	await database.query(
		"update contract_final_delivery_outbox set claimed_at=now()-interval '11 minutes' where envelope_id=$1",
		[envelope],
	);
	uncertain = false;
	// Simulate a deployment that changes the shared branded template between attempts.
	vi.spyOn(brandedEmail, "renderBrandedEmail").mockReturnValue("<p>New release branding</p>");
	await worker.scheduled(
		{} as ScheduledController,
		{
			...env,
			APP_BASE_URL: "https://changed.example.com",
			SIGN_FROM_EMAIL: "changed@example.com",
			SIGN_REPLY_TO_EMAIL: "new-reply@example.com",
		} as Env,
	);
	expect(messages).toHaveLength(2);
	expect(messages[1]).toEqual(messages[0]);
	expect(await statuses(envelope)).toEqual(["delivered"]);
});
it("moves stale attempted mail to manual review after the provider replay window", async () => {
	const envelope = await fixture(1);
	await database.query(
		"update contract_final_delivery_outbox set status='sending', from_email='contracts@example.com', subject='Previous release', text_body='Previous text', html_body='<p>Previous HTML</p>', first_attempt_at=now()-interval '23 hours', claimed_at=now()-interval '11 minutes' where envelope_id=$1",
		[envelope],
	);
	await drain();
	expect(messages).toEqual([]);
	expect(await statuses(envelope)).toEqual(["manual_review"]);
});
it("skips deleted, canceled and replaced final versions", async () => {
	const deleted = await fixture(1);
	const canceled = await fixture(1);
	const replaced = await fixture(1);
	await database.query(
		"insert into audit_events(envelope_id,event_type) values ($1,'envelope.deletion_started')",
		[deleted],
	);
	await database.query("update envelopes set status='expired' where id=$1", [canceled]);
	await database.query("update final_documents set sha256=$2 where envelope_id=$1", [
		replaced,
		"c".repeat(64),
	]);
	await drain();
	expect(messages).toEqual([]);
});
it("does not resend mail after a delivered receipt commits but its response is lost", async () => {
	const envelope = await fixture(1);
	loseReceipt = true;
	await drain();
	expect(await statuses(envelope)).toEqual(["delivered"]);
	await drain();
	expect(messages).toHaveLength(1);
	expect(calls).toBeLessThanOrEqual(10);
});

it("shares three jobs and ten calls between invitations and final delivery", async () => {
	const finalEnvelope = await fixture(3);
	await invitationFixture();
	await drain();
	expect(messages).toHaveLength(3);
	expect(calls).toBeLessThanOrEqual(10);
	expect((await statuses(finalEnvelope)).filter((status) => status === "delivered")).toHaveLength(
		2,
	);
});

async function invitationFixture() {
	const envelope = crypto.randomUUID();
	const recipient = crypto.randomUUID();
	const token = crypto.randomUUID();
	await database.query(
		"insert into envelopes(id,created_by,status) values ($1,'owner@example.com','queued')",
		[envelope],
	);
	await database.query(
		"insert into envelope_recipients(id,envelope_id,name,email,status) values ($1,$2,'Party','invite@example.com','pending')",
		[recipient, envelope],
	);
	await database.query(
		"insert into signer_tokens(id,envelope_id,recipient_id,token,status,expires_at) values ($1,$2,$3,$4,'revoked',now()+interval '7 days')",
		[token, envelope, recipient, crypto.randomUUID()],
	);
	await database.query(
		"insert into contract_invitation_outbox(id,envelope_id,recipient_id,token_id,status,to_email,from_email,subject,text_body,html_body,verification_url) values ($1,$2,$3,$4,'queued','invite@example.com','contracts@example.com','Invite','Body','<p>Body</p>','https://sign.example.com/signing-verifications/invitation')",
		[crypto.randomUUID(), envelope, recipient, token],
	);
	return envelope;
}

it("alternates busy queue priority across consecutive five-minute ticks", async () => {
	const finalEnvelope = await fixture(6);
	for (let index = 0; index < 6; index++) await invitationFixture();
	await worker.scheduled({ scheduledTime: 0 } as ScheduledController, env);
	expect(messages.map((message) => message.key)).toEqual(
		Array(3).fill(expect.stringMatching(/^sign\.invitation\./)),
	);
	expect(calls).toBeLessThanOrEqual(10);
	calls = 0;
	messages = [];
	await worker.scheduled({ scheduledTime: 300_000 } as ScheduledController, env);
	expect(messages.map((message) => message.key)).toEqual(
		Array(3).fill(expect.stringMatching(/^sign\.final\./)),
	);
	expect(calls).toBeLessThanOrEqual(10);
	expect((await statuses(finalEnvelope)).filter((status) => status === "delivered")).toHaveLength(
		3,
	);
});
it("gives remaining final-first slots to invitations within ten calls", async () => {
	const finalEnvelope = await fixture(1);
	for (let index = 0; index < 3; index++) await invitationFixture();
	await worker.scheduled({ scheduledTime: 300_000 } as ScheduledController, env);
	expect(messages).toHaveLength(3);
	expect(calls).toBeLessThanOrEqual(10);
	expect(await statuses(finalEnvelope)).toEqual(["delivered"]);
	expect(messages.filter((message) => message.key.startsWith("sign.invitation."))).toHaveLength(2);
});
