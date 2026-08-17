import z from '@deepseek-ai/schemastery'

/** Plugin configuration for the dsh-login authentication gateway. */
export interface Config {
  /** Credential reference name for the password (e.g. 'DSH_LOGIN_PASSWORD'). */
  password: string
  /** Absolute path to index.html in the frontend dist directory. */
  distIndex: string
  /** Session lifetime in seconds (default: 604800 = 7 days). */
  sessionTtl: number
  /** Whether the gateway is active (default: true). When false, the plugin
   * registers no routes and frontend-static's fallback serves as usual. */
  enabled: boolean
}

export const Config: z<Config> = z.object({
  password: z.string().required(),
  distIndex: z.string().required(),
  sessionTtl: z.natural().default(604800),
  enabled: z.boolean().default(true),
})
