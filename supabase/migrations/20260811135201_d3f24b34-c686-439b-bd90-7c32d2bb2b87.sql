CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  client_name text,
  website_url text,
  description text,
  shared_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT ALL ON public.projects TO service_role;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own projects" ON public.projects FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER t_projects_upd BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.interview_sessions ADD COLUMN project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL;

CREATE TABLE public.meeting_preparations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL UNIQUE REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  meeting_title text,
  meeting_type text NOT NULL DEFAULT 'client_call',
  company_name text,
  client_website text,
  project_name text,
  project_description text,
  role_discussed text,
  requirements text,
  goals text,
  challenges text,
  tech_stack text,
  budget_notes text,
  timeline text,
  client_concerns text,
  important_facts text,
  emphasize text,
  avoid_claims text,
  previous_communication text,
  custom_notes text,
  brief text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_preparations TO authenticated;
GRANT ALL ON public.meeting_preparations TO service_role;
ALTER TABLE public.meeting_preparations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own meeting preparations" ON public.meeting_preparations FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER t_meeting_preparations_upd BEFORE UPDATE ON public.meeting_preparations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.meeting_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  label text NOT NULL,
  value text NOT NULL,
  said_by text NOT NULL DEFAULT 'client',
  confidence numeric NOT NULL DEFAULT 0.7,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_facts_session_idx ON public.meeting_facts (session_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_facts TO authenticated;
GRANT ALL ON public.meeting_facts TO service_role;
ALTER TABLE public.meeting_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own meeting facts" ON public.meeting_facts FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.candidate_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  topic text NOT NULL,
  claim text NOT NULL,
  said_by text NOT NULL DEFAULT 'candidate',
  confidence numeric NOT NULL DEFAULT 0.7,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX candidate_claims_session_idx ON public.candidate_claims (session_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.candidate_claims TO authenticated;
GRANT ALL ON public.candidate_claims TO service_role;
ALTER TABLE public.candidate_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own candidate claims" ON public.candidate_claims FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);