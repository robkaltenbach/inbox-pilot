import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

/**
 * @param {{ temperature?: number }} [options] - Optional sampling (e.g. lower for classification).
 */
export async function callLLM(systemPrompt, userPrompt, options = {}) {
  const provider = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  const temperature = typeof options.temperature === "number" ? options.temperature : undefined;

  if (provider === "anthropic") {
    const anthropic = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null;
    if (!anthropic) throw new Error("Missing ANTHROPIC_API_KEY");
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 700,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      ...(temperature !== undefined ? { temperature } : {})
    });
    const textBlock = resp.content.find((c) => c.type === "text");
    return (textBlock?.text || "").trim();
  }

  if (provider === "openai") {
    const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
    if (!openai) throw new Error("Missing OPENAI_API_KEY");
    const resp = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      ...(temperature !== undefined ? { temperature } : {})
    });
    return (resp.output_text || "").trim();
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}
