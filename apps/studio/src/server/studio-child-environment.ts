const BROKER_ONLY_CREDENTIALS = ["DEEPSEEK_API_KEY"] as const;

export function buildStudioChildEnvironment(
  environment: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment, ...overrides };
  for (const name of BROKER_ONLY_CREDENTIALS) delete childEnvironment[name];
  return childEnvironment;
}
