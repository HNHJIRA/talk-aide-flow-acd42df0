CREATE TABLE public.companion_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
  code text NOT NULL,
  bridge_token text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  companion_os text,
  companion_version text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  approved_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX companion_pairings_code_active_idx ON public.companion_pairings (code) WHERE status = 'pending';
CREATE INDEX companion_pairings_session_idx ON public.companion_pairings (session_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_pairings TO authenticated;
GRANT ALL ON public.companion_pairings TO service_role;

ALTER TABLE public.companion_pairings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own companion pairings"
ON public.companion_pairings FOR ALL TO authenticated
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);