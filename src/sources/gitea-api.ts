import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { sameName } from '../infra/text.ts'
import { SetupError } from '../setup.ts'

const segment = /^[\w.-]+$/
const repositoryName = z.string().trim().refine(value => {
  const parts = value.split('/')
  return parts.length === 2 && parts.every(part => segment.test(part) && part !== '.' && part !== '..')
}, 'Use owner/repository')
const instanceUrl = z.url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !/["\\\s]/.test(url.href)
}, 'Use an HTTPS instance URL without credentials, query or fragment').transform(value => new URL(value).href.replace(/\/+$/, ''))

export const GiteaSchema = z.object({
  instance: z.union([z.literal(''), instanceUrl]).default(''),
  login: z.union([z.literal(''), z.string().trim().regex(/^[\w.-]+$/)]).default(''),
  tokenFile: z.union([z.literal(''), z.string().regex(/^\/[^\r\n\0]+$/)]).default(''),
  repositories: z.array(z.object({ repository: repositoryName })).max(100)
    .refine(rows => new Set(rows.map(row => row.repository.toLowerCase())).size === rows.length, 'Duplicate repositories').default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(60),
})
export type GiteaConfig = z.infer<typeof GiteaSchema>
export type GiteaDeployment = Pick<GiteaConfig, 'instance' | 'login' | 'tokenFile'> & { repositories: string[] }

export const repoUrl = (instance: string, repository: string): string => `${instance}/${repository}`

const Address = z.object({ instance: z.string(), repository: z.string(), number: z.coerce.number().int().positive() })
export function giteaTarget(input: unknown, deployment: GiteaDeployment | undefined) {
  const result = Address.safeParse(input)
  if (!result.success || !deployment || result.data.instance !== deployment.instance || !deployment.repositories.includes(result.data.repository)) return
  return result.data
}

/** Authenticated requests to one Gitea instance, with bounded request time and paginated list reads. */
export class GiteaApi {
  constructor(private readonly instance: string, private readonly token: string, private readonly signal?: AbortSignal) {}

  static async connect(config: Pick<GiteaConfig, 'instance' | 'tokenFile'>, signal?: AbortSignal): Promise<GiteaApi> {
    const token = await readFile(config.tokenFile, 'utf8').catch(() => { throw new Error('Cannot read the Gitea token file') })
    if (!/^[\da-z]+$/i.test(token.trim())) throw new Error('The Gitea token file must contain a personal access token')
    return new GiteaApi(config.instance, token.trim(), signal)
  }

  async request<T>(schema: z.ZodType<T>, path: string, query?: Record<string, string>, body?: object): Promise<T> {
    const url = new URL(`${this.instance}/api/v1/${path}`)
    if (query) url.search = new URLSearchParams(query).toString()
    const response = await fetch(url, {
      redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(this.signal ? [this.signal] : [])]),
      headers: { Authorization: `token ${this.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    }).catch(() => { throw new Error(`Gitea request failed for ${path}`) })
    if (!response.ok) throw new Error(`Gitea HTTP ${response.status} for ${path}`)
    const parsed = schema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) throw new Error(`Unexpected Gitea response for ${path}`)
    return parsed.data
  }

  async *pages<T>(schema: z.ZodType<T>, path: string, query: Record<string, string> = {}): AsyncGenerator<T> {
    for (let page = 1; ; page++) {
      const items = await this.request(z.array(schema), path, { ...query, page: String(page), limit: '50' })
      if (!items.length) return
      yield* items
    }
  }
}

const Pull = z.object({ number: z.number().int().positive(), head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullish() }),
  base: z.object({ ref: z.string() }) })
export async function publishGiteaPull(deployment: GiteaDeployment, origin: unknown, branch: string, title: string, body: string, signal: AbortSignal) {
  const target = giteaTarget(origin, deployment)
  if (!target) throw new Error('The ticket source is outside the configured Gitea repositories')
  const api = await GiteaApi.connect(deployment, signal)
  const repositoryPath = `repos/${target.repository}`
  const path = `${repositoryPath}/pulls`
  const { default_branch: base } = await api.request(z.object({ default_branch: z.string().min(1) }), repositoryPath)
  const result = (number: number) => ({ number, url: `${repoUrl(target.instance, target.repository)}/pulls/${number}` })
  for await (const pull of api.pages(Pull, path, { state: 'open' })) {
    if (pull.head.ref === branch && pull.base.ref === base && sameName(pull.head.repo?.full_name ?? '', target.repository)) return result(pull.number)
  }
  const pull = await api.request(z.object({ number: z.number().int().positive() }), path, undefined,
    { head: branch, base, title, body: `${body}\n\nRefs #${target.number}` })
  return result(pull.number)
}

export async function resolveGitea(value: unknown, signal: AbortSignal): Promise<GiteaDeployment> {
  try {
    const { instance, login, tokenFile, repositories } = GiteaSchema.parse(value)
    if (!instance || !login || !tokenFile || !repositories.length) throw new Error('Set the instance, account, token file and at least one repository')
    const api = await GiteaApi.connect({ instance, tokenFile }, signal)
    const account = await api.request(z.object({ login: z.string() }), 'user')
    if (!sameName(account.login, login)) throw new Error('The token does not belong to the configured account')
    for (const { repository } of repositories) {
      const access = await api.request(z.object({ permissions: z.object({ push: z.boolean() }) }), `repos/${repository}`)
      if (!access.permissions.push) throw new Error(`@${login} cannot push to ${repository}`)
    }
    return { instance, login: account.login, tokenFile, repositories: repositories.map(row => row.repository.toLowerCase()) }
  } catch (error) {
    throw new SetupError('giteaSetupFailed', { output: error instanceof z.ZodError ? 'Invalid Gitea source settings' : String(error) })
  }
}
