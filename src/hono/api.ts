import agentV1Endpoint from "@/hono/api/agent-v1";
import agenticEndpoint from "@/hono/api/agentic";
import clientsEndpoint from "@/hono/api/clients";
import contractsEndpoint from "@/hono/api/contracts";
import envelopePreparationEndpoint from "@/hono/api/envelope-preparation";
import envelopesEndpoint from "@/hono/api/envelopes";
import finalDocumentsEndpoint from "@/hono/api/final-documents";
import healthEndpoint from "@/hono/api/health";
import historyAccessEndpoint from "@/hono/api/history-access";
import historyCreatorEndpoint from "@/hono/api/history-creator";
import historyEnvelopeStartEndpoint from "@/hono/api/history-envelope-start";
import historyHumanReviewEndpoint from "@/hono/api/history-human-review";
import historySigningEndpoint from "@/hono/api/history-signing";
import modeNavigationEndpoint from "@/hono/api/mode-navigation";
import signingEndpoint from "@/hono/api/signing";
import authEndpoint from "@/omh/auth-routes";
import { apiErrorResponse } from "./api-error";
import { createHono } from "./factory";

export const apiHono = createHono().basePath("/api");
// The hosted gate sets x-internal-user-id from the administrator it verified and removes it from
// every other request, so the header marks the callers who may be told the platform's error code.
apiHono.onError((error, c) =>
	apiErrorResponse(error, { administrator: Boolean(c.req.header("x-internal-user-id")) }),
);
apiHono.route("/auth", authEndpoint);
apiHono.route("/contracts", contractsEndpoint);

apiHono.route("/health", healthEndpoint);
apiHono.route("/agentic", agenticEndpoint);
apiHono.route("/v1", agentV1Endpoint);
apiHono.route("/history", historyAccessEndpoint);
apiHono.route("/history", historyCreatorEndpoint);
apiHono.route("/history", historyEnvelopeStartEndpoint);
apiHono.route("/history", historyHumanReviewEndpoint);
apiHono.route("/history", historySigningEndpoint);
apiHono.route("/navigate", modeNavigationEndpoint);
apiHono.route("/clients", clientsEndpoint);
apiHono.route("/envelopes", envelopesEndpoint);
apiHono.route("/envelopes", envelopePreparationEndpoint);
apiHono.route("/final-documents", finalDocumentsEndpoint);
apiHono.route("/signing", signingEndpoint);
