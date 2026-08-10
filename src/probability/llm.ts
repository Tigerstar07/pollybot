import { z } from "zod";
import type { AppConfig } from "../config";
import type { NormalizedMarket, ProbabilityEstimate, SourceObservation } from "../types";
import { clamp } from "../utils";

const LlmEstimateSchema = z.object({
  estimated_yes_probability: z.number().min(0).max(1),
  estimated_no_probability: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reasoning_summary: z.string(),
  key_evidence: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  should_skip: z.boolean().default(false),
});

export async function maybeEstimateWithLlm(
  config: AppConfig,
  market: NormalizedMarket,
  sources: SourceObservation[],
): Promise<ProbabilityEstimate | undefined> {
  if (!config.enableLlmReasoning) return undefined;
  const provider = selectProvider(config);
  if (!provider) return undefined;
  const independentSources = sources.filter((source) => source.available && source.independent);
  if (independentSources.length < config.minIndependentSources) return undefined;

  const prompt = [
    "Return only JSON with estimated_yes_probability, estimated_no_probability, confidence, reasoning_summary, key_evidence, risks, should_skip.",
    "Do not recommend bet size or trading action.",
    `Market: ${market.title}`,
    `Rules: ${market.rules ?? "unknown"}`,
    `Market YES price: ${market.yesPrice ?? "unknown"}`,
    "Use only the supplied independent evidence. The market price is a comparison value, not evidence for the forecast.",
    `Sources: ${JSON.stringify(independentSources.map((source) => source.payload)).slice(0, 4000)}`,
  ].join("\n");

  const raw = await provider(prompt);
  const parsed = LlmEstimateSchema.parse(JSON.parse(raw));
  const yes = clamp(parsed.estimated_yes_probability, 0, 1);
  const dataQuality =
    independentSources.reduce((sum, source) => sum + (source.quality ?? 0.5), 0) / independentSources.length;
  return {
    marketId: market.marketId,
    estimatedYesProbability: yes,
    estimatedNoProbability: 1 - yes,
    confidence: clamp(parsed.confidence, 0, 1),
    method: "llm-structured-reasoning",
    reasoningSummary: parsed.reasoning_summary,
    keyEvidence: parsed.key_evidence,
    risks: parsed.risks,
    independentEvidenceCount: independentSources.length,
    dataQuality: clamp(dataQuality, 0, 1),
    modelUncertainty: clamp((1 - parsed.confidence) * Math.abs(yes - 0.5), 0.02, 0.3),
    shouldSkip: parsed.should_skip || independentSources.length < config.minIndependentSources,
  };
}

function selectProvider(config: AppConfig): ((prompt: string) => Promise<string>) | undefined {
  const provider = config.llmProvider?.toLowerCase();
  if (provider === "ollama" && (config.ollamaHost || process.env.OLLAMA_HOST)) return callOllama(config);
  if (provider === "openai-compatible" && (process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY)) return callOpenAiCompatible(config);
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) return callAnthropic(config);
  if (provider === "gemini" && process.env.GEMINI_API_KEY) return callGemini(config);
  return undefined;
}

function callOpenAiCompatible(config: AppConfig): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const baseUrl = config.openAiCompatibleBaseUrl || "https://api.openai.com/v1";
    const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY;
    const model = config.llmModel || "gpt-4o-mini";
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI-compatible LLM HTTP ${response.status}`);
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "{}";
  };
}

function callAnthropic(config: AppConfig): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.llmModel || "claude-3-5-haiku-latest",
        max_tokens: 800,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic LLM HTTP ${response.status}`);
    const data = (await response.json()) as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text ?? "{}";
  };
}

function callGemini(config: AppConfig): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const model = config.llmModel || "gemini-1.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
      process.env.GEMINI_API_KEY ?? "",
    )}`;
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!response.ok) throw new Error(`Gemini LLM HTTP ${response.status}`);
    const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  };
}

function callOllama(config: AppConfig): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const host = (config.ollamaHost || "http://localhost:11434").replace(/\/$/, "");
    const response = await fetch(`${host}/api/chat`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.llmModel || "llama3.2",
        stream: false,
        messages: [{ role: "user", content: prompt }],
        format: "json",
      }),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const data = (await response.json()) as { message?: { content?: string } };
    return data.message?.content ?? "{}";
  };
}
