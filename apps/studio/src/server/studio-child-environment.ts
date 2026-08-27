const BROKER_ONLY_CREDENTIALS = ["ZAI_BIGMODEL_API_KEY", "ZAI_API_KEY"] as const;

export function buildStudioChildEnvironment(
  environment: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment, ...overrides };
  for (const name of BROKER_ONLY_CREDENTIALS) delete childEnvironment[name];
  return childEnvironment;
}
