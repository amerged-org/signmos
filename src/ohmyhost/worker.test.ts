import worker from "./worker";

const mocks = vi.hoisted(() => ({ withDatabase: vi.fn(), processOne: vi.fn() }));
vi.mock("@/db/setup", () => ({ withDatabase: mocks.withDatabase }));
vi.mock("@/omh/contracts-outbox", () => ({ processContractInvitations: mocks.processOne }));

describe("scheduled invitation processing", () => {
	it("runs the processor inside the current environment's database scope", async () => {
		const env = {} as Env;
		mocks.withDatabase.mockImplementation(async (_env, run: () => Promise<void>) => run());
		await worker.scheduled({} as ScheduledController, env);
		expect(mocks.withDatabase).toHaveBeenCalledWith(env, expect.any(Function));
		expect(mocks.processOne).toHaveBeenCalledWith(env);
	});

	it("propagates processing failures so the scheduler can retry", async () => {
		mocks.withDatabase.mockRejectedValueOnce(new Error("outbox unavailable"));
		await expect(worker.scheduled({} as ScheduledController, {} as Env)).rejects.toThrow(
			"outbox unavailable",
		);
	});
});
