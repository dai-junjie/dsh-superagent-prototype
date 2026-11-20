import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, threadKey, type Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { GiteaApi, GiteaSchema, giteaTarget, repoUrl, type GiteaConfig, type GiteaDeployment } from './gitea-api.ts'
import { mentions } from './github-trigger.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { cursorAt, pause } from './poll.ts'

const SOURCE = 'gitea'
const User = z.object({ login: z.string() })
const DateTime = z.iso.datetime({ offset: true })
const Issue = z.object({ number: z.number().int().positive(), title: z.string(), body: z.string().nullish(), created_at: DateTime,
  user: User.nullish(), pull_request: z.object({}).nullish() })
const Comment = z.object({ id: z.number(), body: z.string().nullish(), updated_at: DateTime, user: User.nullish(),
  issue_url: z.string().nullish(), pull_request_url: z.string().nullish() })

function triggerFor(deployment: GiteaDeployment, repository: string, input: {
  number: number; isPr: boolean; text: string; login: string; at: string; commentId?: number
}): Trigger {
  const { instance, login } = deployment
  const { number, isPr, text, at, commentId } = input
  const thread = { source: SOURCE, id: `${key(instance)}:${repository}:${number}` }
  const url = `${repoUrl(instance, repository)}/${isPr ? 'pulls' : 'issues'}/${number}${commentId === undefined ? '' : `#issuecomment-${commentId}`}`
  return { id: key(thread.id, commentId === undefined ? 'opened' : `comment:${commentId}:${at}`), source: SOURCE, threads: [thread],
    actor: { source: SOURCE, id: input.login.toLowerCase() }, human: !/\[bot\]$/i.test(input.login), at, text, url,
    ...(mentions(text, login) ? { addressed: 'mention' as const } : {}),
    channel: { source: SOURCE, thread: threadKey(thread), address: { instance, repository, number: String(number), url } },
    meta: { instance, repository, number, isPr, kind: commentId !== undefined ? 'comment' : isPr ? 'pull' : 'issue' },
  }
}

export async function pollGitea(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const deployment = ctx.deployment.gitea
  if (!deployment) return
  const api = await GiteaApi.connect(deployment, signal)
  const started = new Date().toISOString()
  const failures: string[] = []
  for (const repository of deployment.repositories) {
    signal.throwIfAborted()
    const checkpoint = `gitea:cursor:${key(deployment.instance, repository)}`
    const since = String(ctx.state.get(checkpoint) ?? started)
    ctx.state.set(checkpoint, since)
    try {
      const path = `repos/${repository}/issues`
      const query = { since, before: started }
      for await (const issue of api.pages(Issue, path, { ...query, state: 'all', type: 'all' })) {
        if (!issue.user || Date.parse(issue.created_at) < Date.parse(since) || sameName(issue.user.login, deployment.login)) continue
        await ctx.receive(triggerFor(deployment, repository, { number: issue.number, isPr: !!issue.pull_request,
          text: `${issue.title}\n\n${issue.body ?? ''}`, login: issue.user.login, at: issue.created_at }))
      }
      for await (const comment of api.pages(Comment, `${path}/comments`, query)) {
        if (!comment.user || sameName(comment.user.login, deployment.login) || Date.parse(comment.updated_at) < Date.parse(since)) continue
        const match = /\/(pulls|issues)\/([1-9]\d*)\/?$/.exec(comment.pull_request_url || comment.issue_url || '')
        if (!match) continue
        await ctx.receive(triggerFor(deployment, repository, { number: Number(match[2]), isPr: match[1] === 'pulls',
          text: comment.body ?? '', login: comment.user.login, at: comment.updated_at, commentId: comment.id }))
      }
      ctx.state.set(checkpoint, cursorAt(started))
    } catch (error) { failures.push(`${repository}: ${String(error)}`) }
  }
  if (failures.length) throw new Error(failures.join('\n'))
}

export const giteaKind: SourceKind<GiteaConfig> = {
  kind: SOURCE,
  defaultEnabled: false,
  title: { zh: 'Gitea', en: 'Gitea' },
  description: { zh: '接收多个仓库的 Issue、PR 和会话评论，在来源仓库交付。', en: 'Receive Issues, PRs and conversation comments from multiple repositories and deliver to the source repository.' },
  schema: GiteaSchema,
  health: [SOURCE],
  fields: [
    { key: 'instance', type: 'text', label: { zh: 'Gitea 实例 URL', en: 'Gitea instance URL' } },
    { key: 'login', type: 'text', label: { zh: '智能体账号', en: 'Agent account' } },
    { key: 'tokenFile', type: 'text', label: { zh: '令牌文件的绝对路径', en: 'Absolute path to the token file' } },
    { key: 'repositories', type: 'rows', label: { zh: '接收的仓库', en: 'Repositories' }, columns: [{ key: 'repository', type: 'text', label: { zh: '所有者/仓库', en: 'owner/repository' } }] },
    { key: 'pollSeconds', type: 'number', min: 10, max: 3600, advanced: true, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  scope: ({ meta }, config) => meta.instance === config.instance && config.repositories.some(row => row.repository.toLowerCase() === meta.repository)
    ? { listened: true, observed: false } : { listened: false, reason: 'repository_not_configured' },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().toLowerCase().regex(/^[\w.-]+$/) })).default([]) }),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Gitea 账号', en: 'Gitea accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }] }],
    explicit: { zh: '名单里的账号 @ 智能体。', en: 'An account on the list mentions the agent.' },
  },
  channel: {
    allowed: (target, config) => target.instance === config.instance && config.repositories.some(row => row.repository.toLowerCase() === target.repository),
    async send({ commands }, message) {
      const deployment = commands.deployment.gitea
      const target = giteaTarget(message.channel.address, deployment)
      if (!deployment || !target) return 'gone'
      const api = await GiteaApi.connect(deployment)
      const path = `repos/${target.repository}/issues/${target.number}/comments`
      const marker = `<!-- dsh-superagent:${message.id} -->`
      for await (const comment of api.pages(Comment, path)) {
        if (sameName(comment.user?.login ?? '', deployment.login) && comment.body?.includes(marker)) return 'sent'
      }
      await api.request(z.unknown(), path, undefined, { body: `${message.text}\n\n${marker}` })
      return 'sent'
    },
    link: target => ({ url: target.url ?? '', label: { zh: `Gitea ${target.repository} #${target.number}`, en: `Gitea ${target.repository} #${target.number}` } }),
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITEA_CLONE_URL', description: { zh: '来源仓库的 Git 地址', en: 'Git URL of the originating repository' } },
      { key: 'DSH_SUPERAGENT_GITEA_ACCOUNT', description: { zh: 'Gitea 上的执行账号', en: 'Agent account on Gitea' } },
      { key: 'DSH_SUPERAGENT_GITEA_NUMBER', description: { zh: '来源 Issue 或 PR 号', en: 'Originating Issue or PR number' } },
      { key: 'DSH_SUPERAGENT_GITEA_PR_HEAD', description: { zh: '来源 PR 的 Git 引用', en: 'Git ref of the originating PR' } },
    ],
    values: ({ deployment, trigger }): Record<string, string> => {
      if (trigger?.source !== SOURCE) return {}
      const target = giteaTarget(trigger.meta, deployment.gitea)
      if (!target) return {}
      return { DSH_SUPERAGENT_GITEA_CLONE_URL: `${repoUrl(target.instance, target.repository)}.git`,
        DSH_SUPERAGENT_GITEA_ACCOUNT: deployment.gitea!.login, DSH_SUPERAGENT_GITEA_NUMBER: String(target.number),
        DSH_SUPERAGENT_GITEA_PR_HEAD: trigger.meta.isPr === true ? `refs/pull/${target.number}/head` : '' }
    },
  },
}

export const name = 'dsh-superagent-gitea'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(giteaKind), 'gitea: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, giteaKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch(error => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GiteaConfig>(SOURCE)
    if (config && ctx.deployment.gitea) {
      try { await pollGitea(ctx, signal); ctx.report(SOURCE, { state: 'ready', detail: 'Watching Gitea repositories' }) }
      catch (error) { if (!signal.aborted) ctx.report(SOURCE, { state: 'error', detail: String(error) }) }
    } else ctx.report(SOURCE, health('paused', 'sourceOff'))
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
