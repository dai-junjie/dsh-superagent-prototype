import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import type { Commands } from '../src/infra/commands.ts'
import { agentVariables, writeEnvironment } from '../src/infra/environment.ts'
import { giteaKind, pollGitea } from '../src/sources/gitea.ts'
import { GiteaSchema, publishGiteaPull, resolveGitea } from '../src/sources/gitea-api.ts'
import type { SourceContext } from '../src/sources/host.ts'

const instance = 'https://gitea.example.test/git'
const repositories = ['team/first', 'team/second']
const token = '0000abcdef'
const login = 'service-agent'
const at = '2026-01-01T00:01:01Z'
const signal = new AbortController().signal
let directory: string
let tokenFile: string
const deployment = () => ({ instance, repositories, login, tokenFile })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-gitea-'))
  tokenFile = join(directory, 'agent token')
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(directory, { recursive: true, force: true })
})

const mockApi = (respond: (path: string, url: URL, request: RequestInit) => unknown) => {
  const fetch = vi.fn(async (url: URL, request: RequestInit) => {
    expect(new Headers(request.headers).get('authorization')).toBe(`token ${token}`)
    expect(request.redirect).toBe('error')
    expect(url.origin + url.pathname.slice(0, '/git'.length)).toBe(instance)
    return Response.json(respond(url.pathname.slice('/git/api/v1/'.length), url, request))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

it('checks the identity and push permission for every configured repository', async () => {
  const config = { instance: `${instance}/`, repositories: repositories.map(repository => ({ repository })), tokenFile, login }
  const fetch = mockApi(path => path === 'user' ? { login } : { permissions: { push: path.endsWith('/first') } })
  await expect(resolveGitea(config, signal)).rejects.toThrow('cannot push to team/second')
  expect(fetch).toHaveBeenCalledTimes(3)
  mockApi(path => path === 'user' ? { login: 'another-user' } : null)
  await expect(resolveGitea(config, signal)).rejects.toThrow('does not belong to the configured account')
  expect(GiteaSchema.safeParse({ ...config, repositories: [{ repository: 'TEAM/first' }, { repository: 'team/FIRST' }] }).success).toBe(false)
})

it('paginates Issue, PR and comment intake, isolates matching numbers by repository, and skips its own posts', async () => {
  const makeIssue = (isPull: boolean) => ({ number: 12, title: 'Change', body: `@${login} please review`, created_at: at,
    user: { login: 'Alice' }, ...(isPull ? { pull_request: {} } : {}) })
  mockApi((path, url) => {
    const page = url.searchParams.get('page')
    if (path.endsWith('/issues')) return page === '1' ? [makeIssue(path.includes('/second/'))] : []
    return page === '1' ? [{ id: 101, body: 'Bot response', user: { login }, updated_at: at }]
      : page === '2' ? [{ id: 102, body: `@${login} here is the repro`, user: { login: 'Alice' }, updated_at: at,
        ...(path.includes('/second/') ? { pull_request_url: `${instance}/team/second/pulls/12` } : { issue_url: `${instance}/team/first/issues/12` }) }] : []
  })
  const triggers: Trigger[] = []
  const state = new Map<string, string>()
  const ctx = { deployment: { gitea: deployment() }, state: { get: (key: string) => state.get(key) ?? at, set: state.set.bind(state) },
    receive: (trigger: Trigger) => { triggers.push(trigger) } } as unknown as SourceContext
  await pollGitea(ctx, signal)
  expect(triggers.map(trigger => [trigger.meta.repository, trigger.meta.kind, trigger.meta.isPr])).toEqual([
    ['team/first', 'issue', false], ['team/first', 'comment', false], ['team/second', 'pull', true], ['team/second', 'comment', true],
  ])
  expect(new Set(triggers.map(trigger => trigger.id)).size).toBe(4)
  expect(new Set(triggers.map(trigger => trigger.channel?.thread)).size).toBe(2)
  expect(triggers.every(trigger => trigger.actor.id === 'alice' && trigger.addressed === 'mention')).toBe(true)
  expect(state.size).toBe(2)
})

it('posts to the origin only and deduplicates a retry after the remote comment exists', async () => {
  const path = 'repos/team/second/issues/12/comments'
  let posted = ''
  const fetch = mockApi((actualPath, url, request) => {
    expect(actualPath).toBe(path)
    if (request.method === 'POST') {
      posted = JSON.parse(String(request.body)).body
      return {}
    }
    return posted && url.searchParams.get('page') === '1' ? [{ id: 19, body: posted, user: { login }, updated_at: at }] : []
  })
  const channel = giteaKind.channel!
  const commands = { deployment: { gitea: deployment() } } as unknown as Commands
  const message = { id: 'delivery', kind: 'reply' as const, text: 'Fixed', channel: { source: 'gitea', thread: 'thread',
    address: { instance, repository: 'team/second', number: '12' } } }
  expect(await channel.send({ commands }, message)).toBe('sent')
  expect(await channel.send({ commands }, message)).toBe('sent')
  expect(fetch.mock.calls.filter(([, request]) => request.method === 'POST')).toHaveLength(1)
  expect(await channel.send({ commands }, { ...message, channel: { ...message.channel,
    address: { ...message.channel.address, repository: 'team/unconfigured' } } })).toBe('gone')
  expect(posted).toContain('Fixed')
})

it('opens and reuses a PR for the ticket branch in the originating repository', async () => {
  let exists = false
  const fetch = mockApi((path, url, request) => {
    if (path === 'repos/team/second') return { default_branch: 'trunk' }
    expect(path).toBe('repos/team/second/pulls')
    if (request.method === 'POST') {
      expect(JSON.parse(String(request.body))).toEqual({ head: 'agent/fix', base: 'trunk', title: 'Fix', body: 'Validated\n\nRefs #12' })
      exists = true
      return { number: 13 }
    }
    return exists && url.searchParams.get('page') === '1' ? [{ number: 13, head: { ref: 'agent/fix', repo: { full_name: 'team/second' } }, base: { ref: 'trunk' } }] : []
  })
  const origin = { instance, repository: 'team/second', number: 12 }
  for (const attempt of [1, 2]) {
    expect(await publishGiteaPull(deployment(), origin, 'agent/fix', 'Fix', 'Validated', signal), `attempt ${attempt}`)
      .toEqual({ number: 13, url: `${instance}/team/second/pulls/13` })
  }
  expect(fetch.mock.calls.filter(([, request]) => request.method === 'POST')).toHaveLength(1)
})

it('supplies Git credentials only for configured Gitea repository URLs', async () => {
  await writeEnvironment({ stateDir: directory, repository: '', github: { cli: '', login: '', noreply: '' }, gitea: deployment() }, [])
  const git = (repository: string) => execFileSync('git', ['credential', 'fill'], { cwd: directory, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    input: `url=${instance}/${repository}.git\n\n`, env: { ...process.env, ...agentVariables(directory) } })
  expect(git('team/second')).toContain(`username=${login}\npassword=${token}\n`)
  expect(() => git('team/unconfigured')).toThrow()
})
