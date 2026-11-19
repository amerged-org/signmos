-- Fresh OMH schema, derived from the upstream production baseline.
-- Foreign keys are defined at table creation so every statement is additive.

CREATE TABLE "agentic_access_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"credential_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "agentic_api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"active_slot" integer,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"surname" text NOT NULL,
	"email" text NOT NULL,
	CONSTRAINT "clients_email_unique" UNIQUE("email")
);

CREATE TABLE "envelopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"signing_mode" text DEFAULT 'me_and_another_signer' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_by" text,
	"sent_at" timestamp with time zone
);

CREATE TABLE "history_access_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"credential_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "rate_limit_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"attempts" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "agentic_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"email" text NOT NULL,
	"link_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agentic_access_requests_link_id_agentic_access_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."agentic_access_links"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "agentic_command_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"review_id" uuid,
	"principal_email" text,
	"token_name" text,
	"reviewer_email" text,
	"reviewer_role" text,
	"reviewer_recipient_id" uuid,
	"reviewer_fields_snapshot" text,
	"reviewer_fields_digest" text,
	"document_title" text,
	"source_document_id" uuid,
	"source_version" integer,
	"source_sha256" text,
	"action_payload" text,
	"action_payload_digest" text,
	"expires_at" timestamp with time zone,
	"decision_at" timestamp with time zone,
	"terminal_reason" text,
	"notification_status" text,
	"notification_provider_message" text,
	"decided_by_email" text,
	"decided_by_session_id" uuid,
	"response_status" integer,
	"response_body" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agentic_command_records_token_id_agentic_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."agentic_api_tokens"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "agentic_email_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"delivery_status" text NOT NULL,
	"provider_message" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agentic_email_records_link_id_agentic_access_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."agentic_access_links"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "agentic_management_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"email" text NOT NULL,
	"session_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agentic_management_sessions_link_id_agentic_access_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."agentic_access_links"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "envelope_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "envelope_recipients_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "final_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "final_documents_r2_key_unique" UNIQUE("r2_key"),
	CONSTRAINT "final_documents_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "history_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"email" text NOT NULL,
	"link_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "history_access_requests_link_id_history_access_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."history_access_links"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "history_email_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"delivery_status" text NOT NULL,
	"provider_message" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "history_email_records_link_id_history_access_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."history_access_links"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "history_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"email" text NOT NULL,
	"session_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "history_sessions_link_id_history_access_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."history_access_links"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"created_by" text NOT NULL,
	"envelope_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "sender_verification_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sender_verification_tokens_token_unique" UNIQUE("token"),
	CONSTRAINT "sender_verification_tokens_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "signature_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"svg_path" text,
	"typed_text" text,
	"typed_font" text,
	"selected" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signature_profiles_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_type" text NOT NULL,
	"original_filename" text DEFAULT 'document.pdf' NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_documents_r2_key_unique" UNIQUE("r2_key"),
	CONSTRAINT "source_documents_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "agentic_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid,
	"session_id" uuid,
	"token_id" uuid,
	"token_name" text,
	"document_id" uuid,
	"email" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"request_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agentic_security_events_link_id_agentic_access_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."agentic_access_links"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "agentic_security_events_session_id_agentic_management_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agentic_management_sessions"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "agentic_security_events_token_id_agentic_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."agentic_api_tokens"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"recipient_id" uuid,
	"event_type" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "audit_events_recipient_id_envelope_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."envelope_recipients"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "envelope_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"type" text NOT NULL,
	"page" integer NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "envelope_fields_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "envelope_fields_recipient_id_envelope_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."envelope_recipients"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "history_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid,
	"session_id" uuid,
	"envelope_id" uuid,
	"email" text NOT NULL,
	"event_type" text NOT NULL,
	"request_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "history_security_events_link_id_history_access_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."history_access_links"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "history_security_events_session_id_history_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."history_sessions"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "history_security_events_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "sender_verification_email_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"fallback_url" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sender_verification_email_records_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "sender_verification_email_records_token_id_sender_verification_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."sender_verification_tokens"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "signer_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signer_tokens_token_unique" UNIQUE("token"),
	CONSTRAINT "signer_tokens_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "signer_tokens_recipient_id_envelope_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."envelope_recipients"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "email_send_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"fallback_url" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_send_records_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "email_send_records_recipient_id_envelope_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."envelope_recipients"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "email_send_records_token_id_signer_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."signer_tokens"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE "field_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"value" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_values_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "field_values_recipient_id_envelope_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."envelope_recipients"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "field_values_field_id_envelope_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."envelope_fields"("id") ON DELETE no action ON UPDATE no action
);

CREATE UNIQUE INDEX "agentic_access_links_credential_hash_unique" ON "agentic_access_links" USING btree ("credential_hash");

CREATE UNIQUE INDEX "agentic_access_requests_idempotency_key_unique" ON "agentic_access_requests" USING btree ("idempotency_key");

CREATE UNIQUE INDEX "agentic_api_tokens_token_hash_unique" ON "agentic_api_tokens" USING btree ("token_hash");

CREATE UNIQUE INDEX "agentic_api_tokens_email_active_slot_unique" ON "agentic_api_tokens" USING btree ("email","active_slot");

CREATE UNIQUE INDEX "agentic_command_records_token_key_unique" ON "agentic_command_records" USING btree ("token_id","idempotency_key");

CREATE UNIQUE INDEX "agentic_command_records_review_id_unique" ON "agentic_command_records" USING btree ("review_id");

CREATE UNIQUE INDEX "agentic_management_sessions_session_hash_unique" ON "agentic_management_sessions" USING btree ("session_hash");

CREATE UNIQUE INDEX "history_access_links_credential_hash_unique" ON "history_access_links" USING btree ("credential_hash");

CREATE UNIQUE INDEX "history_access_requests_idempotency_key_unique" ON "history_access_requests" USING btree ("idempotency_key");

CREATE UNIQUE INDEX "history_sessions_session_hash_unique" ON "history_sessions" USING btree ("session_hash");

CREATE UNIQUE INDEX "idempotency_records_key_operation_created_by_unique" ON "idempotency_records" USING btree ("key","operation","created_by");

CREATE UNIQUE INDEX "rate_limit_records_key_operation_unique" ON "rate_limit_records" USING btree ("key","operation");
