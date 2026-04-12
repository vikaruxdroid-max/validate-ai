const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY as string;

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

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error("[Claude] HTTP", res.status, "body:", errBody);
    throw new Error(`Claude ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const json = await res.json();
  console.log(
    "[Claude] stop_reason:",
    json.stop_reason,
    "content blocks:",
    json.content?.length,
  );
  const textBlock = json.content?.find((b: any) => b.type === "text");
  if (!textBlock?.text) {
    console.error(
      "[Claude] no text block in response, content:",
      JSON.stringify(json.content?.map((b: any) => b.type)),
    );
    throw new Error("No text in Claude response");
  }
  return textBlock.text;
}
