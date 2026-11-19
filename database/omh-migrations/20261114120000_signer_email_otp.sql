-- Expand-only signer email proof. Historical verified_at alone is never browser authority.
CREATE TABLE signer_email_challenges (
 id uuid PRIMARY KEY,
 token_id uuid NOT NULL UNIQUE REFERENCES signer_tokens(id) ON DELETE CASCADE,
 email text NOT NULL,
 code_hash text NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL
);
CREATE TABLE signer_email_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 token_id uuid NOT NULL REFERENCES signer_tokens(id) ON DELETE CASCADE,
 envelope_id uuid NOT NULL,
 recipient_id uuid NOT NULL,
 email text NOT NULL,
 session_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE INDEX signer_email_sessions_token_id ON signer_email_sessions(token_id);
