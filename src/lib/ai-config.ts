export type AiConfiguration = {
  apiKey: string;
  baseURL: string;
  model: string;
  api: 'chat-completions' | 'responses';
};

export function environmentAiConfiguration(
  env: Pick<Env, 'AI_API_KEY' | 'AI_BASE_URL' | 'AI_MODEL'>
): AiConfiguration | null {
  if (
    !env.AI_API_KEY ||
    !env.AI_BASE_URL ||
    !env.AI_MODEL ||
    env.AI_API_KEY.length > 8192
  )
    return null;
  try {
    const url = new URL(env.AI_BASE_URL);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      env.AI_MODEL.length > 200
    )
      return null;
    return {
      apiKey: env.AI_API_KEY,
      baseURL: url.toString(),
      model: env.AI_MODEL,
      api: 'chat-completions',
    };
  } catch {
    return null;
  }
}
