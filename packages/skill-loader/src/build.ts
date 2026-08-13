/**
 * Assemble parsed skill files into an `AgentSkill` the agent loop can consume.
 *
 * Two execution modes:
 *   - declarative: tools.json entries carry an `ipc: "apiName.methodName"` field;
 *     the executor calls `api.apiName.methodName(call.input)` and wraps the result.
 *     Safe by construction (only whitelisted window-API methods are reachable).
 *   - pure prompt: no tools.json. The skill only contributes a systemPrompt
 *     section; executeTool returns an "unused" notice (the loop never calls it
 *     because tools is empty).
 *
 * handler.js imperative skills (stage C) are not wired here yet.
 */
import type { AgentSkill, AgentToolCall, AgentToolDef, ToolExecution } from '@genoffice/agent-core'
import type { ParsedSkillMd, SkillToolDef } from './parse'

/**
 * The window-API surface a host app injects so declarative tools can reach IPC.
 * Each key (e.g. "slidesApi", "desktop", "desktopApi") maps to the preload bridge.
 * Host apps build this from their own `window.*` before loading skills.
 */
export type SkillApi = Record<string, Record<string, (...args: unknown[]) => unknown>>

/** Normalize an arbitrary IPC return value into a ToolExecution. */
function toToolExecution(name: string, result: unknown): ToolExecution {
  // async IPC handlers usually return { ok, ...payload } or { error } or a raw value
  if (result && typeof result === 'object') {
    const r = result as { error?: unknown; ok?: unknown; url?: unknown; text?: unknown }
    if (r.error !== undefined) {
      return {
        output: typeof r.error === 'string' ? r.error : JSON.stringify(r.error),
        isError: true,
        summary: name,
      }
    }
    // heuristics for common payload shapes
    if (typeof r.url === 'string') return { output: `Result: ${r.url}`, summary: name, mutated: false }
    if (typeof r.text === 'string') return { output: r.text, summary: name, mutated: false }
  }
  if (typeof result === 'string') return { output: result, summary: name, mutated: false }
  return { output: JSON.stringify(result), summary: name, mutated: false }
}

/**
 * Build the declarative executor for a set of ipc-annotated tools. Returns null
 * when no tool has an `ipc` field (e.g. pure-prompt skill → tools stay empty).
 */
function declarativeExecutor(
  tools: SkillToolDef[],
  api: SkillApi,
): AgentSkill['executeTool'] | null {
  const ipcMap = new Map<string, string>()
  for (const t of tools) if (t.ipc) ipcMap.set(t.name, t.ipc)
  if (ipcMap.size === 0) return null
  return (call: AgentToolCall, _signal?: AbortSignal): ToolExecution | Promise<ToolExecution> => {
    const ipc = ipcMap.get(call.name)
    if (!ipc) {
      return { output: `tool "${call.name}" has no ipc binding`, isError: true, summary: call.name }
    }
    const [apiName, methodName] = ipc.split('.')
    const ns = apiName ? api[apiName] : undefined
    const fn = ns && methodName ? (ns as Record<string, unknown>)[methodName] : undefined
    if (typeof fn !== 'function') {
      return {
        output: `ipc "${ipc}" is not available in this app`,
        isError: true,
        summary: call.name,
      }
    }
    try {
      const ret = (fn as (...a: unknown[]) => unknown)(call.input)
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        return (ret as Promise<unknown>).then(
          (v) => toToolExecution(call.name, v),
          (e) => ({
            output: `${ipc} failed: ${e instanceof Error ? e.message : String(e)}`,
            isError: true,
            summary: call.name,
          }),
        )
      }
      return toToolExecution(call.name, ret)
    } catch (e) {
      return {
        output: `${ipc} threw: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
        summary: call.name,
      }
    }
  }
}

export interface BuildAgentSkillOptions {
  /** parsed SKILL.md */
  md: ParsedSkillMd
  /** parsed tools.json entries (empty array when no tools.json) */
  tools: SkillToolDef[]
  /** the directory name (used as the skill id) */
  dir: string
  /** host-app window-API surface for declarative tool execution */
  api: SkillApi
}

/**
 * Assemble a fully-resolved AgentSkill from parsed files. The skill id is the
 * directory name; the system prompt is the SKILL.md body prefixed with a short
 * header (name + description) so the LLM can attribute instructions.
 */
export function buildAgentSkill({ md, tools, dir, api }: BuildAgentSkillOptions): AgentSkill {
  const header = `# Skill: ${md.frontmatter.name}\n${md.frontmatter.description}`
  const systemPrompt = md.body ? `${header}\n\n${md.body}` : header

  // strip the `ipc` extension field before handing to the loop (AgentToolDef shape)
  const agentTools: AgentToolDef[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))

  const executor = declarativeExecutor(tools, api)
  return {
    id: dir,
    systemPrompt,
    tools: agentTools,
    executeTool:
      executor ??
      ((call) => ({
        output: `skill "${dir}" defines no executor for tool "${call.name}"`,
        isError: true,
        summary: call.name,
      })),
  }
}
