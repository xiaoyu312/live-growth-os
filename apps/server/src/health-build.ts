const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function resolveHealthBuildId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BUILD_ID?.trim();
  if (raw && BUILD_ID_PATTERN.test(raw)) return raw;
  return "dev";
}
