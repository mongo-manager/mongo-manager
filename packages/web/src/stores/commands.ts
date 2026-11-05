// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ref, toRaw } from 'vue'
import { defineStore } from 'pinia'

export interface Command {
  id: string
  /** A getter re-translates after a language switch; a plain string is used as is. */
  title: string | (() => string)
  keywords?: string
  /** Whether the command can do anything now; the palette leaves it out when it cannot. */
  when?: () => boolean
  /** W5: a group of its own in the palette (a connection's saved items), with the group's name. */
  group?: { id: string; label: () => string }
  run(): void | Promise<void>
}

export const commandTitle = (command: Command): string =>
  typeof command.title === 'function' ? command.title() : command.title

function score(query: string, text: string): number {
  const q = query.toLowerCase()
  const s = text.toLowerCase()
  if (!q) return 1
  if (s.startsWith(q)) return 3
  if (s.includes(q)) return 2
  let i = 0
  for (const ch of s) if (ch === q[i]) i++
  return i === q.length ? 1 : 0
}

export const useCommandsStore = defineStore('commands', () => {
  const commands = ref<Command[]>([])

  function register(command: Command): () => void {
    commands.value = [...commands.value.filter((c) => c.id !== command.id), command]
    return () => {
      // The ref stores reactive proxies: compare the raw objects.
      commands.value = commands.value.filter((c) => toRaw(c) !== command)
    }
  }

  /**
   * Review (minor): many commands at once (a connection's saved items) — one copy of the list, not
   * one per command — taken away together by what it returns.
   */
  function registerMany(list: readonly Command[]): () => void {
    const ids = new Set(list.map((c) => c.id))
    commands.value = [...commands.value.filter((c) => !ids.has(c.id)), ...list]
    const mine = new Set<Command>(list)
    return () => {
      commands.value = commands.value.filter((c) => !mine.has(toRaw(c)))
    }
  }

  function search(query: string): Command[] {
    return commands.value
      .map((c, index) => ({
        c,
        index,
        s: Math.max(score(query, commandTitle(c)), score(query, c.keywords ?? '') && 1),
      }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || a.index - b.index)
      .map((r) => r.c)
  }

  return { commands, register, registerMany, search }
})
