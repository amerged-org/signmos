import { withDatabase } from "@/db/setup";
import { processContractInvitations } from "@/omh/contracts-outbox";
import { processFinalDeliveries } from "@/omh/final-delivery-outbox";

// Scheduled events run in a separate worker from the TanStack HTTP application.
export default {
	async fetch(): Promise<Response> {
		return new Response("Not found", { status: 404 });
	},
	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		await withDatabase(env, async () => {
			// Alternate five-minute priority so sustained traffic cannot starve either queue.
			const finalFirst = Math.floor((controller.scheduledTime ?? 0) / 300_000) % 2 === 1;
			const primary = finalFirst ? processFinalDeliveries : processContractInvitations;
			const secondary = finalFirst ? processContractInvitations : processFinalDeliveries;
			const progress = await primary(env);
			if (!progress.stopped && progress.processed < 3) await secondary(env, 3 - progress.processed);
		});
	},
};
