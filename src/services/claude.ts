const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY as string;
const CLAUDE_TIMEOUT_MS = 30_000;

export async function claudeRequest(
  model: string,
  system: string,
  userMsg: string,
  tools?: any[],
  maxTokens = 256,
): Promise<string> {
  const body: any = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userMsg }],
  };
  if (tools) body.tools = tools;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === "AbortError") throw new Error("Claude API request timed out after 30s");
    throw err;
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    const errBody = await res.text();
    console.error("[Claude] HTTP", res.status, errBody.slice(0, 200));
    throw new Error(`Claude ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const json = await res.json();
  const textBlock = json.content?.find((b: any) => b.type === "text");
  if (!textBlock?.text) {
    console.error("[Claude] no text block in response");
    throw new Error("No text in Claude response");
  }
  return textBlock.text;
}
