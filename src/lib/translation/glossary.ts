/**
 * Technical-term protection for the translation layer.
 *
 * Product, framework and cloud names must survive translation verbatim.
 * We detect them in the source text and hand the list to the provider so the
 * translated output keeps them intact (LLM path), and we repair casing on the
 * way back (all paths).
 */

export const TECHNICAL_TERMS = [
  "React", "React Native", "Next.js", "Node.js", "TypeScript", "JavaScript", "Python", "Java",
  "Kotlin", "Swift", "Go", "Rust", "PHP", "Laravel", "Django", "Flask", "Spring Boot", "Angular",
  "Vue", "Svelte", "Redux", "GraphQL", "REST", "API", "SDK", "CLI", "SQL", "NoSQL", "PostgreSQL",
  "MySQL", "MongoDB", "Redis", "Supabase", "Firebase", "Kubernetes", "Docker", "Terraform",
  "AWS", "Azure", "GCP", "Lambda", "S3", "EC2", "CloudFront", "DynamoDB", "Kafka", "RabbitMQ",
  "CI/CD", "DevOps", "Git", "GitHub", "GitLab", "Jira", "Figma", "Tailwind", "CSS", "HTML",
  "WebSocket", "gRPC", "OAuth", "JWT", "SSO", "RLS", "LLM", "RAG", "OpenAI", "Gemini",
  "TensorFlow", "PyTorch", "Deepgram", "Zoom", "Microsoft Teams", "Google Meet", "Stripe",
  "Shopify", "Salesforce", "SaaS", "B2B", "KPI", "SLA", "MVP", "QA", "UX", "UI", "Hooks",
];

const TERM_INDEX = new Map(TECHNICAL_TERMS.map((t) => [t.toLowerCase(), t]));

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Technical terms actually present in this text, longest-first. */
export function detectTechnicalTerms(text: string): string[] {
  const lower = text.toLowerCase();
  return TECHNICAL_TERMS.filter((term) => lower.includes(term.toLowerCase())).sort(
    (a, b) => b.length - a.length,
  );
}

/** Restore canonical casing/spelling of technical terms in translated output. */
export function repairTechnicalTerms(text: string, terms: string[]): string {
  let out = text;
  for (const term of terms) {
    const canonical = TERM_INDEX.get(term.toLowerCase()) ?? term;
    out = out.replace(new RegExp(`\\b${escape(term)}\\b`, "gi"), canonical);
  }
  return out;
}
