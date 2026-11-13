CREATE TABLE "contract_invitation_outbox" (
 "id" uuid PRIMARY KEY,
 "envelope_id" uuid NOT NULL REFERENCES "envelopes"("id") ON DELETE CASCADE,
 "recipient_id" uuid NOT NULL REFERENCES "envelope_recipients"("id") ON DELETE CASCADE,
 "token_id" uuid NOT NULL REFERENCES "signer_tokens"("id") ON DELETE CASCADE,
 "status" text NOT NULL CHECK ("status" IN ('prepared', 'queued', 'sending', 'delivered', 'uncertain', 'manual_review')),
 "to_email" text NOT NULL,
 "from_email" text NOT NULL,
 "reply_to_email" text,
 "subject" text NOT NULL,
 "text_body" text NOT NULL,
 "html_body" text NOT NULL,
 "verification_url" text NOT NULL,
 "claimed_at" timestamptz,
 "first_attempt_at" timestamptz,
 "created_at" timestamptz NOT NULL DEFAULT now(),
 "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "contract_invitation_outbox_recipient_unique" ON "contract_invitation_outbox" ("recipient_id");
CREATE INDEX "contract_invitation_outbox_status_created_idx" ON "contract_invitation_outbox" ("status", "created_at");
