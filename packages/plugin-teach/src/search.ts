import { TeachArgv, getDialogues, isPositiveInteger, parseTeachArgs, SearchDetails, TeachConfig } from './utils'
import { Dialogue, DialogueTest, DialogueFlag } from './database'
import { Context } from 'koishi-core'
import { getTotalWeight } from './receiver'

declare module 'koishi-core/dist/context' {
  interface EventMap {
    'dialogue/detail-short' (dialogue: Dialogue, output: SearchDetails, argv: TeachArgv): void
    'dialogue/search' (argv: TeachArgv, test: DialogueTest): void | boolean
  }
}

declare module './database' {
  interface Dialogue {
    _redirections: Dialogue[]
  }
}

declare module './utils' {
  interface TeachConfig {
    itemsPerPage?: number
    mergeThreshold?: number
    maxAnswerLength?: number
  }
}

export default function apply (ctx: Context) {
  ctx.command('teach')
    .option('--search', '搜索已有问答', { notUsage: true })
    .option('--page <page>', '设置搜索结果的页码', { validate: isPositiveInteger })
    .option('--auto-merge', '自动合并相同的问题和回答')
    .option('--recursive', '递归查询相关问答')
    .option('|, --pipe <op...>', '对每个搜索结果执行操作')

  ctx.before('dialogue/execute', (argv) => {
    if (argv.options.search) return search(argv)
  })
}

function formatAnswer (source: string, { maxAnswerLength = 100 }: TeachConfig) {
  let trimmed = false
  const lines = source.split(/(\r?\n|\$n)/g)
  if (lines.length > 1) {
    trimmed = true
    source = lines[0].trim()
  }
  source = source.replace(/\[CQ:image,[^\]]+\]/g, '[图片]')
  if (source.length > maxAnswerLength) {
    trimmed = true
    source = source.slice(0, maxAnswerLength)
  }
  if (trimmed && !source.endsWith('……')) {
    if (source.endsWith('…')) {
      source += '…'
    } else {
      source += '……'
    }
  }
  return source
}

function getDetails (argv: TeachArgv, dialogue: Dialogue) {
  const details: SearchDetails = []
  argv.ctx.emit('dialogue/detail-short', dialogue, details, argv)
  if (dialogue.flag & DialogueFlag.keyword) details.questionType = '关键词'
  return details
}

function formatDetails (dialogue: Dialogue, details: SearchDetails) {
  return `${dialogue.id}. ${details.length ? `[${details.join(', ')}] ` : ''}`
}

function formatPrefix (argv: TeachArgv, dialogue: Dialogue, showAnswerType = false) {
  const details = getDetails(argv, dialogue)
  let result = formatDetails(dialogue, details)
  if (details.questionType) result += `[${details.questionType}] `
  if (showAnswerType && details.answerType) result += `[${details.answerType}] `
  return result
}

export function formatAnswers (argv: TeachArgv, dialogues: Dialogue[], padding = 0) {
  return dialogues.map((dialogue) => {
    const { answer, _redirections } = dialogue
    const output = `${'=> '.repeat(padding)}${formatPrefix(argv, dialogue, true)}${formatAnswer(answer, argv.config)}`
    if (!_redirections) return output
    return [output, ...formatAnswers(argv, _redirections, padding + 1)].join('\n')
  })
}

export function formatQuestionAnswers (argv: TeachArgv, dialogues: Dialogue[]) {
  return dialogues.map((dialogue) => {
    const details = getDetails(argv, dialogue)
    const { questionType = '问题', answerType = '回答' } = details
    const { original, answer, _redirections } = dialogue
    const output = `${formatDetails(dialogue, details)}${questionType}：${original}，${answerType}：${formatAnswer(answer, argv.config)}`
    if (!_redirections) return output
    return [output, ...formatAnswers(argv, _redirections, 1)].join('\n')
  })
}

async function search (argv: TeachArgv) {
  const { ctx, meta, options } = argv
  const { keyword, question, answer, page = 1, original, pipe, recursive } = options
  const { itemsPerPage = 20, mergeThreshold = 5, _stripQuestion } = argv.config

  const test: DialogueTest = { question, answer, keyword }
  if (ctx.bail('dialogue/search', argv, test)) return
  const dialogues = await getDialogues(ctx, test)

  if (pipe) {
    if (!dialogues.length) return meta.$send('没有搜索到任何问答。')
    const command = ctx.getCommand('teach', meta)
    parseTeachArgs(Object.assign(meta.$argv, command.parse(pipe)))
    meta.$argv.options.target = dialogues.map(d => d.id).join(',')
    return command.execute(meta.$argv)
  }

  if (recursive) {
    const questions: Record<string, Dialogue[]> = {
      [test.question]: dialogues,
    }

    await (async function getRedirections (dialogues: Dialogue[]) {
      for (const dialogue of dialogues) {
        const { answer } = dialogue
        if (!answer.startsWith('${dialogue ')) continue
        const [question] = _stripQuestion(answer.slice(11, -1).trimStart())
        if (question in questions) continue
        questions[question] = await getDialogues(ctx, {
          ...test,
          keyword: false,
          question,
        })
        Object.defineProperty(dialogue, '_redirections', { writable: true, value: questions[question] })
        await getRedirections(questions[question])
      }
    })(dialogues)
  }

  function sendResult (title: string, output: string[], suffix?: string) {
    if (output.length <= itemsPerPage) {
      output.unshift(title + '：')
      if (suffix) output.push(suffix)
    } else {
      const pageCount = Math.ceil(output.length / itemsPerPage)
      output = output.slice((page - 1) * itemsPerPage, page * itemsPerPage)
      output.unshift(title + `（第 ${page}/${pageCount} 页）：`)
      if (suffix) output.push(suffix)
      output.push('可以使用 --page 或在 ## 之后加上页码以调整输出的条目页数。')
    }
    return meta.$send(output.join('\n'))
  }

  if (!question && !answer) {
    if (!dialogues.length) return meta.$send('没有搜索到任何回答，尝试切换到其他环境。')
    return sendResult('全部问答如下', formatQuestionAnswers(argv, dialogues))
  }

  if (!options.keyword) {
    if (!question) {
      if (!dialogues.length) return meta.$send(`没有搜索到回答“${answer}”，请尝试使用关键词匹配。`)
      const output = dialogues.map(d => `${formatPrefix(argv, d)}${d.original}`)
      return sendResult(`回答“${answer}”的问题如下`, output)
    } else if (!answer) {
      if (!dialogues.length) return meta.$send(`没有搜索到问题“${original}”，请尝试使用关键词匹配。`)
      const output = formatAnswers(argv, dialogues)
      const state = ctx.getSessionState(meta)
      state.isSearch = true
      state.test = test
      state.dialogues = dialogues
      const total = await getTotalWeight(ctx, state)
      return sendResult(`问题“${original}”的回答如下`, output, dialogues.length > 1 ? `实际触发概率：${+Math.min(total, 1).toFixed(3)}` : '')
    } else {
      if (!dialogues.length) return meta.$send(`没有搜索到问答“${original}”“${answer}”，请尝试使用关键词匹配。`)
      const output = [dialogues.map(d => d.id).join(', ')]
      return sendResult(`“${original}”“${answer}”匹配的回答如下`, output)
    }
  }

  let output: string[]
  if (!options.autoMerge || question && answer) {
    output = formatQuestionAnswers(argv, dialogues)
  } else {
    const idMap: Record<string, number[]> = {}
    for (const dialogue of dialogues) {
      const key = question ? dialogue.original : dialogue.answer
      if (!idMap[key]) idMap[key] = []
      idMap[key].push(dialogue.id)
    }
    output = Object.keys(idMap).map((key) => {
      const { length } = idMap[key]
      return length <= mergeThreshold
        ? `${key} (#${idMap[key].join(', #')})`
        : `${key} (共 ${length} 个${question ? '回答' : '问题'})`
    })
  }

  if (!question) {
    if (!dialogues.length) return meta.$send(`没有搜索到含有关键词“${answer}”的回答。`)
    return sendResult(`回答关键词“${answer}”的搜索结果如下`, output)
  } else if (!answer) {
    if (!dialogues.length) return meta.$send(`没有搜索到含有关键词“${original}”的问题。`)
    return sendResult(`问题关键词“${original}”的搜索结果如下`, output)
  } else {
    if (!dialogues.length) return meta.$send(`没有搜索到含有关键词“${original}”“${answer}”的问答。`)
    return sendResult(`问答关键词“${original}”“${answer}”的搜索结果如下`, output)
  }
}
