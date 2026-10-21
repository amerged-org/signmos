CREATE TABLE "envelope_artifact_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "envelope_id" uuid NOT NULL REFERENCES "envelopes" ("id"),
  "r2_key" text NOT NULL UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "envelope_artifact_versions_envelope_id_idx"
  ON "envelope_artifact_versions" ("envelope_id");
