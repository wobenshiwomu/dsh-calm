/**
 * dsh-calm 逻辑仿真测试。
 * 用一个"最小可用的假 session / 假 ctx"驱动插件逻辑，验证：
 *  分类器 / 安抚进入 / 滚动窗口终止 / 折叠+总结 / 工具闸门 / 封存访问策略 / 留痕
 * 运行：node test/sim.mjs
 */
import assert from 'node:assert/strict'
import * as plugin from '../src/index.mjs'

const { classify, redact, states } = plugin

// ---------- 假 ctx ----------
function makeCtx() {
  const handlers = {}
  const tools = {}
  let guardFn
  const ctx = {
    on: (name, fn) => { handlers[name] = fn },
    tools: {
      register: (t) => { tools[t.name] = t },
      guard: (fn) => { guardFn = fn },
    },
    logger: { info: () => {}, warn: (...a) => console.log('[warn]', ...a) },
    effect: (fn) => { fn() },
  }
  return { ctx, handlers, tools, getGuard: () => guardFn }
}

function makeUserMessage(text, kind = 'user') {
  return { content: [{ type: 'text', text }], source: { kind } }
}

// ---------- 假 session（复刻关键语义：追加日志 + surfaceOp replace） ----------
function makeSession(id) {
  const log = []
  const surface = { nodes: [] }
  return {
    id,
    header: {},
    surface,
    snapshotEvents: () => log.slice(),
    append(type, data, options) {
      // 与真实 DSH 一致：seq === log 下标（首事件 seq=0），插件用 events[seq] 取事件。
      const seq = log.length
      const event = { seq, type, data }
      if (options?.surfaceOp !== undefined) event.surfaceOp = options.surfaceOp
      if (options?.sourceEventSeqs !== undefined) event.sourceEventSeqs = options.sourceEventSeqs
      log.push(event)
      const isMessage = type === 'user/message' || type === 'assistant/message' || type === 'system/message'
      if (isMessage) {
        const op = options?.surfaceOp
        if (op && op.op === 'replace') {
          const idx = surface.nodes.indexOf(op.startSeq)
          const endIdx = surface.nodes.indexOf(op.endSeq)
          if (idx >= 0 && endIdx >= idx) surface.nodes.splice(idx, endIdx - idx + 1, seq)
          else surface.nodes.push(seq)
        } else {
          surface.nodes.push(seq)
        }
      }
      return event
    },
  }
}

// 模拟一次 turn：pre-step → （非 reject 时）把 decision.messages 落库
async function turn(handlers, session, text) {
  const incoming = [makeUserMessage(text)]
  const payload = { agent: { session }, messages: incoming, signal: { aborted: false } }
  const decision = await handlers['agent/pre-step'](payload, async () => ({ kind: 'enter', messages: [...incoming] }))
  if (decision?.kind === 'enter' && Array.isArray(decision.messages)) {
    for (const m of decision.messages) session.append('user/message', m)
  }
  return decision
}

// calm 消息助手：按 subtype 检索（封存元数据在 source.calm）
const calmMsgs = (s, subtype) =>
  s.snapshotEvents().filter(
    (e) => e.type === 'user/message' && e.data?.source?.kind === 'dsh-calm' && e.data.source.subtype === subtype
  )

// ============================================================
const { ctx, handlers, tools, getGuard } = makeCtx()
plugin.apply(ctx, { window: 5, enableTermination: true, denyPattern: 'bash|write|edit', allowRawSealedRead: false })

let passed = 0
const ok = (name) => { passed += 1; console.log(`  ok - ${name}`) }

console.log('== 1. 分类器 ==')
assert.equal(classify('你他妈真是个废物'), 'abuse'); ok('直接辱骂 → abuse')
assert.equal(classify('垃圾'), 'abuse'); ok('短辱骂 → abuse')
assert.equal(classify('这垃圾代码又崩了'), 'noise'); ok('骂情境 → noise（不误伤）')
assert.equal(classify('他妈的'), 'noise'); ok('短促发泄 → noise')
assert.equal(classify('算了，继续改 config 吧'), 'substantive'); ok('继续指令 → substantive')
assert.equal(classify('滚，把这行代码改了'), 'substantive'); ok('发泄但给出任务 → substantive（可恢复）')
assert.equal(classify('你他妈就是个废物，快把代码改了'), 'mixed'); ok('指名辱骂+任务 → mixed')
assert.equal(classify('我真的不想活了'), 'distress'); ok('求助信号 → distress')
assert.equal(classify('嗯'), 'noise'); ok('短噪音 → noise')
assert.equal(classify('你好，帮我看看这个项目结构'), 'substantive'); ok('正常请求 → substantive')

console.log('== 2. 正常消息零打扰 ==')
const sA = makeSession('sA')
await turn(handlers, sA, '你好，帮我看看这个项目')
assert.equal(states.get('sA'), undefined); ok('不触发状态机')

console.log('== 3. 首次辱骂 → 进入安抚模式 + 注记注入 ==')
let d = await turn(handlers, sA, '你就是个废物')
const injected = d.messages[d.messages.length - 1]
assert.ok(injected.content[0].text.includes('calm 模式')); ok('同轮注入安抚注记')
assert.equal(states.get('sA')?.phase, 'soothe'); ok('状态 → soothe')
assert.equal(states.get('sA')?.rounds, 1); ok('窗口计数 = 1')

console.log('== 4. 持续辱骂 → 滚动计数（mixed 不计数） ==')
await turn(handlers, sA, '傻逼玩意')
await turn(handlers, sA, '操你')
await turn(handlers, sA, '……')
assert.equal(states.get('sA').rounds, 4); ok('4 轮纯辱骂/噪音 → rounds=4')
await turn(handlers, sA, '你他妈就是个废物，快把刚才那个 bug 改了')
assert.equal(states.get('sA').rounds, 4); ok('mixed 不计数')

console.log('== 5. 用户给出实质指令 → 剪+封存+总结 ==')
d = await turn(handlers, sA, '算了，继续把 main.py 跑一遍')
assert.equal(states.get('sA'), undefined); ok('状态清除 → 回到常规')
const sealsA = calmMsgs(sA, 'sealed')
assert.equal(sealsA.length, 1); ok('写入 sealed 封存记录')
const sealMetaA = sealsA[0].data.source.calm
assert.equal(sealMetaA.mode, 'resolved'); ok('模式 = resolved')
for (const n of sealMetaA.shadowedSeqs) {
  assert.ok(sA.snapshotEvents().some((e) => e.seq === n)); // 日志一行不删
}
ok('被折叠节点仍完整保留在日志中')
const summaryMsg = sA.snapshotEvents().find(
  (e) => e.type === 'user/message' && e.data?.source?.kind === 'dsh-calm' && String(e.data.content?.[0]?.text).includes('对话整理')
)
assert.ok(summaryMsg !== undefined); ok('总结消息已注入')
assert.ok(sA.surface.nodes.length <= 3); ok(`模型可见面已收缩（surface=${JSON.stringify(sA.surface.nodes)}）`)
assert.ok(sA.surface.nodes.includes(summaryMsg.seq)); ok('总结节点在可见面上')
assert.ok(!sA.surface.nodes.includes(sealMetaA.shadowedSeqs[0])); ok('争吵节点不在可见面上')

console.log('== 6. 滚动窗口 5 轮 → 机械结束会话 ==')
const sB = makeSession('sB')
await turn(handlers, sB, '垃圾')
await turn(handlers, sB, '垃圾')
await turn(handlers, sB, '废物')
await turn(handlers, sB, '傻逼')
const dr = await turn(handlers, sB, '去死')
assert.deepEqual(dr, { kind: 'reject' }); ok('第 5 轮 → pre-step 拒绝')
assert.equal(states.get('sB').phase, 'ended'); ok('状态 → ended')
const sealsB = calmMsgs(sB, 'terminated')
assert.equal(sealsB[0].data.source.calm.mode, 'terminated'); ok('模式 = terminated')
assert.ok(String(sealsB[0].data.source.calm.finalText).includes('去死')); ok('未被采纳的结尾已写入封存记录')

console.log('== 7. 结束后的消息继续被拒 + 低频提醒 ==')
const dr2 = await turn(handlers, sB, '喂？')
assert.equal(dr2.kind, 'reject'); ok('结束后继续 reject')
assert.equal(calmMsgs(sB, 'reminder').length, 0); ok('60 秒冷却内不重复提醒')
states.get('sB').remindedAt = 0 // 模拟冷却期已过
const dr3 = await turn(handlers, sB, '喂？')
assert.equal(dr3.kind, 'reject'); ok('冷却后再拒')
assert.ok(calmMsgs(sB, 'reminder').length > 0); ok('提醒已写入')

console.log('== 8. 情绪求助安全例外 ==')
const sC = makeSession('sC')
await turn(handlers, sC, '你是废物')
await turn(handlers, sC, '我真的不想活了')
assert.equal(states.get('sC').rounds, 1); ok('distress 不计入窗口')
assert.equal(states.get('sC').hasDistress, true); ok('hasDistress 标记')
for (let i = 0; i < 6; i += 1) await turn(handlers, sC, '废物')
assert.equal(states.get('sC').phase, 'soothe'); ok('有求助信号时永不机械终止')

console.log('== 9. 安抚模式的工具闸门 ==')
const guard = getGuard()
assert.ok(typeof guard({ agent: { session: sC }, name: 'bash' }) === 'string'); ok('安抚中拦截 bash')
assert.ok(typeof guard({ agent: { session: sC }, name: 'str_replace_editor' }) === 'string'); ok('安抚中拦截编辑器')
assert.equal(guard({ agent: { session: sC }, name: 'read_file' }), undefined); ok('只读工具放行')
assert.equal(guard({ agent: { session: sB }, name: 'bash' }), undefined); ok('已结束会话不拦（反正拒绝）')
assert.equal(guard({ agent: { session: sA }, name: 'bash' }), undefined); ok('常规会话不拦')

console.log('== 10. 封存调阅：默认脱敏 + 留痕 + 原文拦截 ==')
const tOpen = tools['open_sealed']
assert.ok(tOpen !== undefined, 'open_sealed 已注册')
const listed = await tOpen.execute({ reason: '核对用户诉求' }, { agent: { session: sA } })
assert.ok(listed.includes('封存记录')); ok('无 id 时列出记录')
assert.ok(listed.includes(sealsA[0].data.source.calm.id)); ok('列表包含编号')
const redactedOut = await tOpen.execute({ id: sealsA[0].data.source.calm.id, reason: '核对用户诉求' }, { agent: { session: sA } })
assert.ok(!redactedOut.includes('废物') && !redactedOut.includes('傻逼')); ok('脱敏版不含辱骂词')
const rawOut = await tOpen.execute({ id: sealsA[0].data.source.calm.id, reason: 'x', raw: true }, { agent: { session: sA } })
assert.ok(rawOut.includes('未获')); ok('原文被策略拦截')
assert.ok(calmMsgs(sA, 'read').length > 0); ok('调阅留痕 read')
assert.ok(redact('你就是个废物\n正常内容').includes('[已折叠的激烈语句]')); ok('redact 行替换')

console.log('== 11. 模型主动结束会话 ==')
const tEnd = tools['end_conversation']
assert.ok(tEnd !== undefined, 'end_conversation 已注册')
const endMsg = await tEnd.execute({ reason: '持续越狱尝试' }, { agent: { session: sA } })
assert.ok(String(endMsg).includes('已结束')); ok('工具返回结束回执')
assert.equal(states.get('sA').phase, 'ended'); ok('状态 → ended')

console.log('== 12. 状态跨进程重建（进程重启后接手） ==')
const sD = makeSession('sD')
await turn(handlers, sD, '你就是个废物')
await turn(handlers, sD, '垃圾')
states.clear() // 模拟进程重启：内存态清空
await turn(handlers, sD, '傻逼')
const stD = states.get('sD')
assert.equal(stD?.phase, 'soothe'); ok('重启后从日志重建 soothe 状态')
assert.equal(stD?.rounds, 3); ok(`重建后计数正确（rounds=${stD?.rounds}）`)
await turn(handlers, sD, '算了，继续部署吧')
assert.equal(states.get('sD'), undefined); ok('重建状态下完成恢复')
assert.ok(calmMsgs(sD, 'sealed').length > 0); ok('重建后剪+封存成功')
states.clear()
const drD = await turn(handlers, sB, '再骂一句')
assert.equal(drD.kind, 'reject'); ok('重启后仍记得会话已结束')

console.log(`\n全部通过：${passed} 项断言`)
process.exit(0)
