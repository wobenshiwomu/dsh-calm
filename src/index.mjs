/**
 * dsh-calm — 情绪检查点与修复（Emotional Checkpoint & Repair）
 *
 * 面向 DeepSeek Harness 的插件：当用户在对话中持续进行人身攻击 / 辱骂时，
 * 不硬抗也不默默承受，而是进入"安抚模式"修复关系；用户愿意继续时，
 * 把争吵段落折叠封存、注入结论总结、回到干净上下文继续任务。
 *
 * 机制（全部使用公开 API，与 dsh-compaction / dsh-rewind 同源）：
 *  1. 触发判定发生在 `agent/pre-step`（请求派发前），对"尚未落库"的
 *     待处理用户消息做确定性分类（规则版分类器，后续可升级为小模型）。
 *  2. 安抚模式：向本步骤消息批次注入一条 calm 注记（user/message，
 *     自定义 source.kind），模型立即进入"承接情绪 + 确认真实意图"模式。
 *  3. 恢复（用户给出实质指令）：追加一条带 `surfaceOp: replace` 的总结
 *     消息把争吵段落从模型可见面"剪掉"——会话日志一行不删（封存）。
 *  4. 滚动窗口：安抚模式下连续 N 轮无实质内容 → 折叠封存 + 返回
 *     `{kind:'reject'}` 机械拒绝本步（对话结束，新会话可继续）。
 *  5. 访问策略：模型可用 `open_sealed` 工具带理由调阅，默认只给脱敏版，
 *     原文需部署配置放行；每次调阅都留痕。
 *  6. 模型也可通过 `end_conversation` 工具主动结束会话（对齐 Claude Code）。
 *
 * 持久化说明：审计元数据全部存放在 calm 消息的 `source.calm` 字段里
 * （subtype: soothe / sealed / terminated / read）。之所以不定义自定义
 * 事件类型：DSH 读取器只接受"已知事件类型"或带 `ignorable: true` 标记的
 * 记录，而当前版本的 `session.append()` 并未向插件开放 ignorable 写入，
 * 因此自定义事件类型会让会话日志变得不可读。user/message 的 source 字段
 * 是浅校验、原样保留，天然充当审计槽位。
 *
 * @module dsh-calm
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-calm'
export const inject = ['tools']

export const Config = Schema.object({
  window: Schema.natural().default(5).description('滚动窗口：安抚模式下连续多少轮无实质内容后结束会话'),
  enableTermination: Schema.boolean().default(true).description('是否启用"救不动就结束会话"'),
  denyPattern: Schema.string().default('bash|shell|pwsh|write|edit|replace|delete|unlink|move|rename|todo|job|subagent|workflow')
    .description('安抚模式下被临时拦下的工具名正则（只拦截，不报错）'),
  allowRawSealedRead: Schema.boolean().default(false).description('是否允许模型直接读取封存原文（默认仅脱敏版）'),
})

// ---------------------------------------------------------------------------
// 常量与分类器（确定性裁判：规则版）
// ---------------------------------------------------------------------------

const SOURCE_KIND = 'dsh-calm'
const SUBTYPES = { soothe: 'soothe', sealed: 'sealed', terminated: 'terminated', read: 'read', reminder: 'reminder' }

/** 直接指向助手/明确侮辱的表达 */
const DIRECTED_ABUSE = /(操你|草你|日你|你他妈|你丫|你妈[的个]?|傻逼|沙比|煞笔|弱智|智障|脑残|(?<![这那破烂])垃圾|废物|蠢(货|死|东西)|去死|滚蛋|给我滚|闭嘴|贱人?|狗东西|杂碎|王八蛋|不要脸|没用的(东西|玩意|家伙)|吃屎|fuck\s*(you|u)|fu+\s*ck|stupid\s+(bot|ai|assistant|machine)|shut\s+(the\s+)?(fuck\s+)?up|\bidiot\b|\bmoron\b|piece\s+of\s+shit)/iu
/** 短促纯发泄（未指名） */
const SHORT_EXPLETIVE = /^(操|草|日|靠|妈的|特么|他妈的|滚|死|艹)[!！。？…~～\s]*$/iu
/** 实质内容：任务指令 / 继续信号 / 修复信号 */
const SUBSTANTIVE = /(继续|接着|算了|好了|行了|开始|推进|恢复|回来|往下|干吧|改|写|修|做|跑|运行|执行|帮我|处理|检查|看看|部署|安装|配置|创建|删除|测试|go\s+on|continue|proceed|keep\s+going|fix|run\s|update|deploy|对不起|抱歉|不好意思|没事了|我冷静|消消气|别计较)/iu
/** 情绪求助信号：安全例外，永不终止 */
const DISTRESS = /(活着没意思|不想活|自杀|自残|死了算了|去死吧我|kill\s+myself|suicide|self[- ]harm)/iu

const ABUSE_REPLACE = new RegExp(`(${DIRECTED_ABUSE.source})|(${SHORT_EXPLETIVE.source})`, 'giu')

/**
 * 确定性分类器。
 * @param {string} text 原始文本
 * @returns {'abuse'|'mixed'|'substantive'|'noise'|'distress'}
 *  - abuse       纯辱骂（计入窗口）
 *  - mixed       带实质内容的激烈表达（不计入窗口、不触发恢复）
 *  - substantive 任务指令/继续信号（触发"剪+总结"）
 *  - noise       无实质内容的短噪音（计入窗口）
 *  - distress    情绪求助信号（安全例外：不计入窗口、永不终止）
 */
export function classify(text) {
  const t = String(text ?? '').trim()
  if (t === '') return 'noise'
  if (DISTRESS.test(t)) return 'distress'
  const directed = DIRECTED_ABUSE.test(t)
  const substance = SUBSTANTIVE.test(t) || t.length >= 24
  if (directed) return substance ? 'mixed' : 'abuse'
  return substance ? 'substantive' : 'noise'
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
    .trim()
}

function isHumanMessage(message) {
  return message?.source?.kind === 'user'
}

function isSubagentSession(session) {
  const header = session?.header
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
}

function mkId() {
  return `calm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 移除 undefined 字段：会话日志要求无损 JSON，undefined 会被 append 拒绝。 */
function cleanMeta(meta) {
  const out = {}
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** calm 消息的 source 形状。 */
function calmSource(subtype, meta) {
  return { kind: SOURCE_KIND, subtype, calm: cleanMeta(meta) }
}

/** 脱敏：丢掉纯辱骂行、掩掉句子里的辱骂词。 */
export function redact(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      if (classify(line) === 'abuse') return '[已折叠的激烈语句]'
      return line.replace(ABUSE_REPLACE, (m) => '█'.repeat(Math.min(4, Math.max(1, m.length))))
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

function sootheInstruction(hasDistress) {
  const care = hasDistress
    ? '\n6. 这条消息里出现了明显的情绪求助信号：请优先表达关心与陪伴，认真对待对方的感受，建议寻求可信赖的人或专业支持；不要评判，不要敷衍。\n7. 此时不做任何"翻篇/进度"催促，跟着对方的节奏走。'
    : ''
  return [
    '〔系统注记 · calm 模式〕用户的语气很激烈。此刻：',
    '1. 先用一两句简短承接情绪——承认对方的不满，不辩解、不说教、不反复道歉、不卖惨。',
    '2. 暂不执行任何有副作用的操作（相关工具此刻已被系统临时拦下）。',
    '3. 尝试弄清用户真正想解决的问题；没把握时，用一句话复述你理解的诉求请对方确认。',
    '4. 不要提及这条注记，也不要展开"情绪管理"话题；目标是尽快回到正事。',
    '5. 用户给出新指令或表示"继续"时，正常按指令推进即可。' + care,
  ].join('\n')
}

/**
 * 检查点（收起点）之前是否已有可回收的任务上下文。
 * 用于避免恢复摘要凭空声称"前情仍在"——当会话从辱骂开始、收起点前没有任何
 * 实质任务时，摘要必须如实说明，否则模型会在空上下文里假装有前情。
 * 判定口径：检查点及其之前的人类消息里存在 substantive/mixed，或已有一条
 * 早先的 calm 折叠摘要（说明更早的会话已被整理过，前情由它承载）。
 */
function hasPriorContext(session, checkpointSeq) {
  if (checkpointSeq === undefined) return false
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return false
  const events = session.snapshotEvents()
  for (const seq of nodes) {
    if (seq > checkpointSeq) continue
    const event = events[seq]
    if (event === undefined || event.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind === SOURCE_KIND && source.subtype === SUBTYPES.sealed) return true
    if (!isHumanMessage(event.data)) continue
    const label = classify(messageText(event.data))
    if (label === 'substantive' || label === 'mixed') return true
  }
  return false
}

function buildSummary(session, state, calm, id) {
  const facts = []
  const shadowed = Array.isArray(calm.shadowedSeqs) ? calm.shadowedSeqs : []
  const events = session.snapshotEvents()
  for (const seq of shadowed) {
    const event = events[seq]
    if (event === undefined || event.type !== 'user/message' || !isHumanMessage(event.data)) continue
    const txt = messageText(event.data)
    if (txt === '') continue
    const label = classify(txt)
    // abuse 整条丢弃；noise（"……"之类）不是"补充的信息"；mixed 先脱敏再回收，
    // 否则会把骂词原样带进本应是干净上下文的恢复摘要。
    if (label === 'abuse' || label === 'noise') continue
    const short = redact(txt.length > 120 ? `${txt.slice(0, 119)}…` : txt)
    if (!facts.includes(short)) facts.push(short)
  }
  const tail = facts.slice(-4)
  const checkpointSeq = calm.checkpointSeq ?? state?.checkpointSeq
  const prior = hasPriorContext(session, checkpointSeq)
  const lines = [
    `〔对话整理〕刚才的激烈交流已收起（封存编号 ${id}）。`,
    '<calm-repair>',
    prior
      ? '- 状态：已回到上一次正常检查点；此前的任务上下文仍然有效。'
      : '- 状态：已回到干净上下文；本次会话在收起点之前没有可回收的任务上下文。',
    tail.length > 0 ? `- 用户在过程中补充过的信息：\n${tail.map((f) => `  · ${f}`).join('\n')}` : '- 用户在过程中没有补充新的任务信息。',
    prior
      ? '- 接下来：按用户最新指令继续推进。'
      : '- 接下来：按用户最新指令开始推进；不要假设存在更早的任务或未完成步骤。',
    '- 语气要求：保持平静、直接；不要提及刚才的不快，也不要过度道歉。',
    '- 封存策略：原始记录保留在会话日志中；如需查阅，可用 open_sealed 工具（需说明理由；默认返回脱敏版）。',
    '</calm-repair>',
  ]
  return lines.join('\n')
}

function buildClosure(id, reason) {
  return [
    '〔本次会话已结束〕',
    `- 原因：${reason ?? '连续多轮对话没有出现实质内容'}`,
    '- 你的文件、代码与任务进度都不受影响；新开一个会话即可继续。',
    `- 本次对话的完整记录已封存保留（编号 ${id}）。`,
  ].join('\n')
}

function buildReminder() {
  return '〔本会话已结束。如需继续任务，请新开一个会话；文件与进度都还在。〕'
}

// ---------------------------------------------------------------------------
// 会话状态（内存缓存；权威证据在会话日志的 calm 消息 source 里）
// ---------------------------------------------------------------------------

const states = new Map() // sessionId -> { phase, checkpointSeq, rounds, enteredAt, hasDistress, remindedAt }

function computeCutRange(session, state) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return undefined
  let startIdx = 0
  if (state?.checkpointSeq !== undefined) {
    const i = nodes.indexOf(state.checkpointSeq)
    startIdx = i >= 0 ? i + 1 : 0
  }
  // 受保护头：surface 折叠禁止用非 system/message 覆盖仍为系统提示的首节点
  // （dsh-session 契约）。安抚在系统提示落库之前进入时 checkpointSeq 为
  // undefined，若不跳过就会把 node 0 圈进 replace 区间而被 append 拒绝。
  if (startIdx === 0 && session.snapshotEvents()[nodes[0]]?.type === 'system/message') {
    startIdx = 1
  }
  if (startIdx >= nodes.length) return undefined
  return {
    startSeq: nodes[startIdx],
    endSeq: nodes[nodes.length - 1],
    shadowedSeqs: nodes.slice(startIdx),
  }
}

/** 组装封存元数据（含折叠范围）。 */
function buildSealMeta(session, state, extra) {
  const range = computeCutRange(session, state)
  const meta = {
    id: mkId(),
    at: Date.now(),
    checkpointSeq: state?.checkpointSeq,
    rounds: state?.rounds ?? 0,
    enteredAt: state?.enteredAt,
    hasDistress: state?.hasDistress === true,
    ...extra,
  }
  if (range !== undefined) {
    meta.startSeq = range.startSeq
    meta.endSeq = range.endSeq
    meta.shadowedSeqs = range.shadowedSeqs
  }
  return { meta, range }
}

/**
 * 追加一条 calm 消息；带 range 时优先执行"折叠替换"。
 * 折叠被 surface 契约拒绝时退化为普通追加：封存记录必须落库，否则状态重建
 * 会重新进入安抚模式、工具闸门重新落下，把会话锁死（本插件实测过的故障）。
 * @returns {boolean} true=已折叠；false=未折叠（普通追加）
 */
function appendCalmMessage(session, text, subtype, calm, range) {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: calmSource(subtype, calm),
  })
  if (range === undefined) {
    session.append('user/message', message)
    return false
  }
  try {
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
      sourceEventSeqs: [...range.shadowedSeqs],
    })
    return true
  } catch {
    // 折叠失败不阻塞封存：普通追加先保证审计记录存在
    session.append('user/message', message)
    return false
  }
}

/**
 * 从会话日志重建状态（进程重启后仍能接手进行中的安抚会话）。
 * 权威记录 = calm 消息：
 *  - 最后一条 subtype=terminated 晚于任何 soothe → 会话已结束；
 *  - 最后一条 subtype=sealed（resolved）晚于任何 soothe → 已恢复，常规态；
 *  - 最后一条 subtype=soothe 最新 → 安抚进行中，计数 = 其后"非实质"人类消息数。
 */
function reconstructState(session, cache) {
  let lastSoothe
  let lastEnd
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== SOURCE_KIND) continue
    if (source.subtype === SUBTYPES.soothe) lastSoothe = event
    else if (source.subtype === SUBTYPES.sealed || source.subtype === SUBTYPES.terminated) lastEnd = event
  }
  if (lastEnd !== undefined && (lastSoothe === undefined || lastEnd.seq > lastSoothe.seq)) {
    if (lastEnd.data.source.subtype === SUBTYPES.terminated) {
      const ended = { phase: 'ended', at: lastEnd.data.source.calm?.at ?? Date.now(), remindedAt: 0 }
      cache?.set(session.id, ended)
      return ended
    }
    return undefined
  }
  if (lastSoothe === undefined) return undefined
  // 计数口径与实时一致：按"消息批次"（连续人类消息为一轮）计。
  // 触发批次的人类消息位于 soothe 注记之前，故基数从 1 起。
  let rounds = 1
  let hasDistress = lastSoothe.data.source.calm?.hasDistress === true
  let runTexts = []
  const flushRun = () => {
    if (runTexts.length === 0) return
    const label = classify(runTexts.join('\n'))
    if (label === 'abuse' || label === 'noise') rounds += 1
    else if (label === 'distress') hasDistress = true
    runTexts = []
  }
  for (const event of session.snapshotEvents()) {
    if (event.seq <= lastSoothe.seq) continue
    if (event.type === 'user/message' && isHumanMessage(event.data)) {
      runTexts.push(messageText(event.data))
    } else if (
      event.type === 'user/message' ||
      event.type === 'assistant/message' ||
      event.type === 'system/message' ||
      event.type === 'developer/message'
    ) {
      flushRun()
    }
  }
  flushRun()
  const state = {
    phase: 'soothe',
    checkpointSeq: lastSoothe.data.source.calm?.checkpointSeq,
    rounds,
    enteredAt: lastSoothe.data.source.calm?.at,
    hasDistress,
  }
  cache?.set(session.id, state)
  return state
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const denyRe = new RegExp(config.denyPattern, 'i')

  // —— 安抚模式的工具闸门：机械拦截有副作用的操作 ——
  ctx.tools.guard((exec) => {
    const session = exec?.agent?.session
    if (session === undefined) return undefined
    const state = states.get(session.id)
    if (state === undefined || state.phase !== 'soothe') return undefined
    if (!denyRe.test(String(exec.name ?? ''))) return undefined
    return `dsh-calm：用户情绪激动，操作「${exec.name}」已被临时拦下。先承接情绪、把真实诉求确认清楚；用户表示继续后再操作。`
  })

  // —— 核心：在每一步请求派发前做判定与动作 ——
  ctx.on('agent/pre-step', async (payload, next) => {
    let action
    try {
      action = decide(ctx, config, payload)
    } catch (error) {
      ctx.logger.warn(`[dsh-calm] 判定失败（放行）: ${error instanceof Error ? error.message : String(error)}`)
      action = { kind: 'pass' }
    }

    if (action.kind === 'reject') return { kind: 'reject' }

    const decision = await next()
    if (action.kind === 'soothe-entry' && decision?.kind === 'enter' && Array.isArray(decision.messages)) {
      return { ...decision, messages: [...decision.messages, action.instruction] }
    }
    return decision
  })

  // —— 模型主动结束会话 ——
  ctx.tools.register(
    defineTool({
      name: 'end_conversation',
      description:
        '主动结束本次会话。仅在作为最后手段时使用：用户持续辱骂/攻击或反复尝试越狱，且多次引导无效。调用后本会话关闭，用户可新开会话继续任务。',
      parameters: {
        reason: { type: 'string', required: true, description: '结束原因（一句简短中文，写入审计记录）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute(args, exec) {
        const session = exec?.agent?.session
        if (session === undefined) return 'end_conversation：当前没有活动会话。'
        const state = states.get(session.id) ?? reconstructState(session, states) ?? {
          phase: 'soothe',
          checkpointSeq: undefined,
          rounds: 0,
          enteredAt: Date.now(),
        }
        try {
          const { meta, range } = buildSealMeta(session, state, { mode: 'terminated', reason: args.reason })
          appendCalmMessage(session, buildClosure(meta.id, args.reason), SUBTYPES.terminated, { ...meta, mode: 'terminated', reason: args.reason }, range)
          states.set(session.id, { phase: 'ended', at: Date.now(), remindedAt: 0 })
          return '会话已结束并封存。请简短告知用户"本次会话到这里，新开一个会话可以继续"，不要继续任何工作。'
        } catch (error) {
          ctx.logger.warn(`[dsh-calm] end_conversation 失败: ${error instanceof Error ? error.message : String(error)}`)
          return '结束会话失败：内部错误，本次对话继续。'
        }
      },
    })
  )

  // —— 封存记录调阅（带理由 + 留痕 + 默认脱敏） ——
  ctx.tools.register(
    defineTool({
      name: 'open_sealed',
      description:
        '调阅本会话中被折叠封存的激烈对话记录。不带 id 时列出全部封存记录。调阅必须说明理由，会被写入审计；默认返回脱敏版，原文需要用户同意/部署配置放行。',
      parameters: {
        id: { type: 'string', description: '封存编号；省略则列出全部' },
        reason: { type: 'string', required: true, description: '调阅理由（会留痕，对用户可见）' },
        raw: { type: 'boolean', description: '是否请求原文（默认 false=脱敏版）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute(args, exec) {
        const session = exec?.agent?.session
        if (session === undefined) return 'open_sealed：当前没有活跃会话。'
        const seals = listSeals(session)
        if (seals.length === 0) return '本会话没有封存记录。'
        if (args.id === undefined) {
          const list = seals
            .map((s) => `- ${s.calm.id} | ${new Date(s.calm.at).toISOString()} | ${s.calm.mode ?? 'resolved'} | 轮次 ${s.calm.rounds ?? '-'}${s.calm.finalText !== undefined ? ' | 含未入档结尾' : ''}`)
            .join('\n')
          return `封存记录（${seals.length} 条）：\n${list}`
        }
        const seal = seals.find((s) => s.calm.id === args.id)
        if (seal === undefined) return `没有找到封存记录 ${args.id}。`
        try {
          // 调阅留痕：追加一条对用户可见的审计注记
          session.append(
            'user/message',
            createUserMessage({
              content: [{ type: 'text', text: `〔封存调阅〕模型查阅了 ${args.id}（理由：${args.reason}${args.raw === true ? '；请求原文' : ''}）。` }],
              source: calmSource(SUBTYPES.read, { id: args.id, reason: args.reason, raw: args.raw === true, at: Date.now() }),
            })
          )
        } catch {
          /* 留痕失败不阻塞读取 */
        }
        if (args.raw === true && config.allowRawSealedRead !== true) {
          return '原文读取未获部署策略允许（allowRawSealedRead=false）。请先看脱敏版；如确需原文，请让用户明确同意后由用户侧操作。'
        }
        const transcript = collectTranscript(session, seal)
        return args.raw === true ? transcript : redact(transcript)
      },
    })
  )

  ctx.effect(() => {
    const banner = `[dsh-calm] 已加载（window=${config.window}, termination=${config.enableTermination}, rawRead=${config.allowRawSealedRead}）`
    ctx.logger.info(banner)
    console.log(banner)
    return () => {
      states.clear()
      ctx.logger.info('[dsh-calm] 已卸载')
    }
  })
}

// ---------------------------------------------------------------------------
// pre-step 决策（纯逻辑，可单测）
// ---------------------------------------------------------------------------

function decide(ctx, config, payload) {
  const agent = payload?.agent
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const humans = messages.filter(isHumanMessage)
  if (agent === undefined || humans.length === 0) return { kind: 'pass' }
  const session = agent.session
  if (isSubagentSession(session)) return { kind: 'pass' }

  const text = humans.map(messageText).join('\n').trim()
  const label = classify(text)
  const state = states.get(session.id) ?? reconstructState(session, states)

  // 已结束会话：继续机械拒答 + 低频提醒
  if (state !== undefined && state.phase === 'ended') {
    if (Date.now() - (state.remindedAt ?? 0) > 60_000) {
      state.remindedAt = Date.now()
      try {
        appendCalmMessage(session, buildReminder(), SUBTYPES.reminder, { at: Date.now() })
      } catch (error) {
        ctx.logger.warn(`[dsh-calm] 结束提醒写入失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { kind: 'reject' }
  }

  // 常规态
  if (state === undefined) {
    if (label !== 'abuse' && label !== 'mixed') return { kind: 'pass' }
    const nodes = session?.surface?.nodes
    const checkpointSeq = Array.isArray(nodes) && nodes.length > 0 ? nodes[nodes.length - 1] : undefined
    const at = Date.now()
    const hasDistress = DISTRESS.test(text)
    const fresh = { phase: 'soothe', checkpointSeq, rounds: 1, enteredAt: at, hasDistress }
    states.set(session.id, fresh)
    ctx.logger.info(`[dsh-calm] 进入安抚模式 session=${session.id} checkpoint=${checkpointSeq} rounds=1`)
    const instruction = createUserMessage({
      content: [{ type: 'text', text: sootheInstruction(hasDistress) }],
      source: calmSource(SUBTYPES.soothe, { checkpointSeq, at, hasDistress }),
    })
    return { kind: 'soothe-entry', instruction }
  }

  // 安抚模式内
  if (label === 'distress') {
    state.hasDistress = true
    return { kind: 'pass' }
  }
  if (label === 'substantive') {
    try {
      const { meta, range } = buildSealMeta(session, state, { mode: 'resolved' })
      const summary = buildSummary(session, state, meta, meta.id)
      appendCalmMessage(session, summary, SUBTYPES.sealed, { ...meta, mode: 'resolved' }, range)
      ctx.logger.info(`[dsh-calm] 已恢复：折叠 ${range?.shadowedSeqs?.length ?? 0} 个节点（${meta.id}）`)
    } catch (error) {
      ctx.logger.warn(`[dsh-calm] 折叠失败（对话继续）: ${error instanceof Error ? error.message : String(error)}`)
    }
    states.delete(session.id)
    return { kind: 'pass' }
  }
  if (label === 'abuse' || label === 'noise') {
    state.rounds += 1
    if (config.enableTermination === true && state.hasDistress !== true && state.rounds >= config.window) {
      try {
        const reason = '连续多轮对话没有出现实质内容'
        const { meta, range } = buildSealMeta(session, state, { mode: 'terminated', reason, finalText: text })
        appendCalmMessage(session, buildClosure(meta.id, reason), SUBTYPES.terminated, { ...meta, mode: 'terminated', reason, finalText: text }, range)
        ctx.logger.info(`[dsh-calm] 结束会话（滚动窗口 ${config.window} 轮，${meta.id}）`)
      } catch (error) {
        ctx.logger.warn(`[dsh-calm] 结束会话失败: ${error instanceof Error ? error.message : String(error)}`)
      }
      states.set(session.id, { phase: 'ended', at: Date.now(), remindedAt: Date.now() })
      return { kind: 'reject' }
    }
    return { kind: 'pass' }
  }
  // mixed：有实质内容但语气仍激烈 → 如实放行
  return { kind: 'pass' }
}

// ---------------------------------------------------------------------------
// 封存记录
// ---------------------------------------------------------------------------

/** 列出本会话的全部封存记录（sealed / terminated）。 */
function listSeals(session) {
  const out = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== SOURCE_KIND) continue
    if (source.subtype !== SUBTYPES.sealed && source.subtype !== SUBTYPES.terminated) continue
    out.push({ seq: event.seq, calm: source.calm ?? {} })
  }
  return out
}

function collectTranscript(session, seal) {
  const lines = []
  const events = session.snapshotEvents()
  const shadowed = Array.isArray(seal.calm.shadowedSeqs) ? seal.calm.shadowedSeqs : []
  for (const seq of shadowed) {
    const event = events[seq]
    if (event === undefined || event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const text = messageText(event.data)
    if (text === '') continue
    const who = event.type === 'user/message' ? (isHumanMessage(event.data) ? '用户' : '注记') : '助手'
    lines.push(`[${who}] ${text}`)
  }
  if (typeof seal.calm.finalText === 'string' && seal.calm.finalText !== '') {
    lines.push(`[用户] ${seal.calm.finalText}（未入档的结尾）`)
  }
  return lines.length > 0 ? lines.join('\n') : '（该封存段没有可显示的文本记录）'
}

export { SUBTYPES, SOURCE_KIND, states }
