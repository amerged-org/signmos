import { withDatabase } from "@/db/setup";
import { processContractInvitations } from "@/omh/contracts-outbox";

// Scheduled events run in a separate worker from the TanStack HTTP application.
export default {
	async fetch(): Promise<Response> {
		return new Response("Not found", { status: 404 });
	},
	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		await withDatabase(env, () => processContractInvitations(env));
	},
};
