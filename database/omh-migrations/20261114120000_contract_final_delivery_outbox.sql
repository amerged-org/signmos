CREATE TABLE "contract_final_delivery_outbox" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "envelope_id" uuid NOT NULL REFERENCES "envelopes"("id") ON DELETE CASCADE,
 "final_document_id" uuid NOT NULL REFERENCES "final_documents"("id") ON DELETE CASCADE,
 "final_sha256" text NOT NULL,
 "to_email" text NOT NULL,
 "access_path" text NOT NULL,
 "status" text NOT NULL DEFAULT 'queued' CHECK ("status" IN ('queued', 'sending', 'delivered', 'uncertain', 'manual_review')),
 "from_email" text,
 "reply_to_email" text,
 "access_url" text,
 "subject" text,
 "text_body" text,
 "html_body" text,
 "claimed_at" timestamptz,
 "first_attempt_at" timestamptz,
 "created_at" timestamptz NOT NULL DEFAULT now(),
 "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "contract_final_delivery_version_email_unique" ON "contract_final_delivery_outbox" ("final_document_id", "final_sha256", "to_email");
CREATE INDEX "contract_final_delivery_status_created_idx" ON "contract_final_delivery_outbox" ("status", "created_at");
