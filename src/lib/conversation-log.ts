/** Write one notification attempt's diagnostics to a local text file. */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Append timestamped diagnostics for one notification. */
export interface ConversationLog {
  /** Absolute path of this log file. */
  readonly path: string
  /**
   * Append one stage and its text to the conversation file.
   * @param stage - processing stage shown in the log.
   * @param content - text recorded for this stage.
   */
  write(stage: string, content: string): void
}

/**
 * Create an exclusively owned log file for one notification attempt.
 * @param directory - directory in which to create conversation logs.
 * @param kind - notification feed name.
 * @param sourceId - Bilibili comment ID, validated as a decimal identifier.
 * @returns an appender for the new file.
 * @throws when the directory or file cannot be created.
 */
export function createConversationLog(directory: string, kind: 'at' | 'reply', sourceId: string): ConversationLog {
  return createLog(directory, `${kind}-${sourceId}`)
}

/**
 * Create the HTTP request log for one running plugin instance.
 * @param directory - directory in which to create the log.
 * @returns an appender for the new file.
 * @throws when the directory or file cannot be created.
 */
export function createRequestLog(directory: string): ConversationLog {
  return createLog(directory, 'requests')
}

function createLog(directory: string, label: string): ConversationLog {
  // 递归创建日志目录；目录已存在时不报错。新建目录在 POSIX 系统上的权限仅允许当前用户访问。
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  // 用当前毫秒时间、日志类型和随机 UUID 命名，方便区分不同通知或插件运行产生的日志。
  const file = join(directory, `${String(Date.now())}-${label}-${randomUUID()}.log`)
  // 先创建空文件；`wx` 表示文件已存在就失败，不覆盖旧日志。POSIX 系统上文件权限仅当前用户可读写。
  writeFileSync(file, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return {
    path: file,
    write(stage, content) {
      // 每次追加都记录毫秒时间戳、处理阶段和内容，末尾空两行便于阅读。
      appendFileSync(file, `[${String(Date.now())} ms] ${stage}\n${content}\n\n`, 'utf8')
    },
  }
}
