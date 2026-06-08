// Standalone model policy: the agent uses whatever model the user configured.
import { getProvider } from '../provider'

export async function resolveBuilderModel(): Promise<string> {
  return getProvider()?.model || ''
}
