import { z } from "zod";

export const VerifySignerEmailCodeSchema = z.object({
	code: z.string().regex(/^\d{6}$/),
});
