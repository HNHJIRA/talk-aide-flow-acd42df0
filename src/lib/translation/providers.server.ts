/**
 * TranslationProvider abstraction (server-side only).
 *
 * The UI never talks to a provider directly: it calls the `translate` server
 * function, which picks the fastest AVAILABLE provider. Adding a key for
 * Google / DeepL / Azure enables that adapter automatically; with no key at
 * all, the fast-LLM fallback (Lovable AI Gateway) is used, which is also the
 * only path able to produce transliterations such as Roman Urdu.
 */

import { detectTechnicalTerms, repairTechnicalTerms } from "./glossary";
import { TRANSLITERATION_TARGETS, type TranslationProviderId } from "./translation-protocol";

export type TranslateRequest = {
  text: string;
  source: string; // "auto" allowed
  target: string;
  /** Meeting topic / facts, used only by the context-aware LLM path. */
  context?: string;
  preferred?: TranslationProviderId;
  /** Interim (still-being-spoken) text: prefer the fastest possible path. */
  partial?: boolean;
};

export type TranslateResponse = {
  text: string;
  provider: Exclude<TranslationProviderId, "auto">;
  detectedSource: string;
  serverMs: number;
};

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const FAST_MODEL = "google/gemini-2.5-flash-lite";

const env = (name: string) => process.env[name] || "";

/** Which adapters can run right now, fastest-first. */
export function availableProviders(): Exclude<TranslationProviderId, "auto">[] {
  const list: Exclude<TranslationProviderId, "auto">[] = [];
  if (env("GOOGLE_TRANSLATE_API_KEY")) list.push("google");
  if (env("DEEPL_API_KEY")) list.push("deepl");
  if (env("AZURE_TRANSLATOR_KEY")) list.push("azure");
  if (env("LOVABLE_API_KEY")) list.push("ai");
  return list;
}

/** BCP-47 code for the machine-translation APIs (they have no Roman Urdu). */
const mtCode = (code: string) => (code === "roman_ur" ? "ur" : code);

async function googleTranslate(req: TranslateRequest): Promise<TranslateResponse> {
  const key = env("GOOGLE_TRANSLATE_API_KEY");
  const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: req.text,
      target: mtCode(req.target),
      format: "text",
      ...(req.source && req.source !== "auto" ? { source: mtCode(req.source) } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Google Translate ${res.status}`);
  const json = (await res.json()) as {
    data?: { translations?: { translatedText: string; detectedSourceLanguage?: string }[] };
  };
  const first = json.data?.translations?.[0];
  if (!first) throw new Error("Google Translate: empty response");
  return {
    text: first.translatedText,
    provider: "google",
    detectedSource: first.detectedSourceLanguage ?? req.source,
    serverMs: 0,
  };
}

async function deeplTranslate(req: TranslateRequest): Promise<TranslateResponse> {
  const key = env("DEEPL_API_KEY");
  const host = key.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
  const res = await fetch(`https://${host}/v2/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `DeepL-Auth-Key ${key}` },
    body: JSON.stringify({
      text: [req.text],
      target_lang: mtCode(req.target).toUpperCase(),
      ...(req.source && req.source !== "auto"
        ? { source_lang: mtCode(req.source).toUpperCase() }
        : {}),
    }),
  });
  if (!res.ok) throw new Error(`DeepL ${res.status}`);
  const json = (await res.json()) as {
    translations?: { text: string; detected_source_language?: string }[];
  };
  const first = json.translations?.[0];
  if (!first) throw new Error("DeepL: empty response");
  return {
    text: first.text,
    provider: "deepl",
    detectedSource: (first.detected_source_language ?? req.source).toLowerCase(),
    serverMs: 0,
  };
}

async function azureTranslate(req: TranslateRequest): Promise<TranslateResponse> {
  const key = env("AZURE_TRANSLATOR_KEY");
  const region = env("AZURE_TRANSLATOR_REGION") || "global";
  const params = new URLSearchParams({ "api-version": "3.0", to: mtCode(req.target) });
  if (req.source && req.source !== "auto") params.set("from", mtCode(req.source));
  const res = await fetch(`https://api.cognitive.microsofttranslator.com/translate?${params}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": key,
      "Ocp-Apim-Subscription-Region": region,
    },
    body: JSON.stringify([{ Text: req.text }]),
  });
  if (!res.ok) throw new Error(`Azure Translator ${res.status}`);
  const json = (await res.json()) as {
    translations?: { text: string }[];
    detectedLanguage?: { language: string };
  }[];
  const first = json[0]?.translations?.[0];
  if (!first) throw new Error("Azure Translator: empty response");
  return {
    text: first.text,
    provider: "azure",
    detectedSource: json[0]?.detectedLanguage?.language ?? req.source,
    serverMs: 0,
  };
}

const LANGUAGE_INSTRUCTION: Record<string, string> = {
  roman_ur:
    "Roman Urdu — Urdu written in Latin script the way Pakistanis type on WhatsApp (e.g. 'Ap apna pichla experience bata sakte hain'). Never use Arabic script.",
  ur: "Urdu in Arabic script.",
  hi: "Hindi in Devanagari script.",
};

/** Context-aware fallback: also the only path that can transliterate. */
async function aiTranslate(req: TranslateRequest): Promise<TranslateResponse> {
  const key = env("LOVABLE_API_KEY");
  if (!key) throw new Error("Translation is not configured.");
  const terms = detectTechnicalTerms(req.text);
  const targetRule = LANGUAGE_INSTRUCTION[req.target] ?? `the language with code "${req.target}"`;

  const system = [
    "You are a real-time meeting interpreter. Translate the user's line and output ONLY the translation.",
    `Target: ${targetRule}`,
    req.source && req.source !== "auto"
      ? `The source language is "${req.source}".`
      : "Detect the source language yourself.",
    "Keep the speaker's tone and register. Never answer the question, never explain, never add quotes or notes.",
    "Keep technical terms, product names, frameworks and acronyms in their original English form.",
    terms.length ? `Keep these EXACTLY as written: ${terms.join(", ")}.` : "",
    "The input may be an unfinished sentence; translate what is there without completing it.",
    req.context ? `Meeting context (for disambiguation only):\n${req.context.slice(0, 700)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": key },
    body: JSON.stringify({
      model: FAST_MODEL,
      stream: false,
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: "system", content: system },
        { role: "user", content: req.text },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw Object.assign(new Error(`AI translation ${res.status}: ${detail.slice(0, 120)}`), {
      status: res.status,
    });
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = (json.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("AI translation returned nothing");
  return {
    text: repairTechnicalTerms(text, terms),
    provider: "ai",
    detectedSource: req.source,
    serverMs: 0,
  };
}

const ADAPTERS: Record<
  Exclude<TranslationProviderId, "auto">,
  (req: TranslateRequest) => Promise<TranslateResponse>
> = { google: googleTranslate, deepl: deeplTranslate, azure: azureTranslate, ai: aiTranslate };

/**
 * Pick and run a provider. Machine-translation providers are tried first for
 * short live text (they are the fastest), the LLM is the context-aware
 * fallback — and the only option for transliteration targets.
 */
export async function translateWithBestProvider(
  req: TranslateRequest,
): Promise<TranslateResponse> {
  const t0 = Date.now();
  const available = availableProviders();
  if (!available.length) throw new Error("No translation provider is configured.");

  const transliteration = TRANSLITERATION_TARGETS.includes(
    req.target as (typeof TRANSLITERATION_TARGETS)[number],
  );

  let order: Exclude<TranslationProviderId, "auto">[];
  if (transliteration) {
    order = ["ai"];
  } else if (req.preferred && req.preferred !== "auto" && available.includes(req.preferred)) {
    order = [req.preferred, ...available.filter((p) => p !== req.preferred)];
  } else {
    order = available;
  }
  order = order.filter((p) => available.includes(p));
  if (!order.length) {
    throw new Error(
      transliteration
        ? "Roman Urdu needs the AI translation fallback, which is unavailable."
        : "No translation provider is configured.",
    );
  }

  let lastError: unknown = null;
  for (const id of order) {
    try {
      const out = await ADAPTERS[id](req);
      return { ...out, serverMs: Date.now() - t0 };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Translation failed");
}
