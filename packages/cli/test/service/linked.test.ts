import { describe, expect, it } from 'vitest'
import { linkedLibraries, loadPaths } from '../../src/service/linked'
import { elf64, fat, macho64 } from './binaries'

describe('reading what an executable loads (final review 1f-3, Critical 1)', () => {
  it('reads the ELF interpreter, needed libraries and run path', () => {
    const linked = linkedLibraries(
      elf64({
        interpreter: '/home/linuxbrew/.linuxbrew/lib/ld.so',
        needed: ['libicuuc.so.76', 'libc.so.6'],
        runpath: '$ORIGIN/../lib:/home/linuxbrew/.linuxbrew/lib',
      }),
    )
    expect(linked).toEqual({
      format: 'elf',
      interpreter: '/home/linuxbrew/.linuxbrew/lib/ld.so',
      needed: ['libicuuc.so.76', 'libc.so.6'],
      rpaths: ['$ORIGIN/../lib', '/home/linuxbrew/.linuxbrew/lib'],
    })
    expect(loadPaths(linked, '/opt/mongo-manager/app/bin/node')).toEqual([
      '/home/linuxbrew/.linuxbrew/lib/ld.so',
      '/opt/mongo-manager/app/bin/../lib',
      '/home/linuxbrew/.linuxbrew/lib',
    ])
  })

  it('reads Mach-O libraries and run paths, in every slice of a universal binary', () => {
    const brew = macho64({
      dylibs: [
        '/usr/lib/libSystem.B.dylib',
        '/opt/homebrew/opt/icu4c@77/lib/libicui18n.77.dylib',
        '@rpath/libuv.1.dylib',
      ],
      rpaths: ['@loader_path/../lib'],
    })
    const linked = linkedLibraries(fat([macho64(), brew]))
    expect(linked.needed).toContain('/opt/homebrew/opt/icu4c@77/lib/libicui18n.77.dylib')
    expect(loadPaths(linked, '/Library/Application Support/Mongo Manager/app/bin/node')).toEqual([
      '/Library/Application Support/Mongo Manager/app/bin/../lib',
      '/opt/homebrew/opt/icu4c@77/lib/libicui18n.77.dylib',
    ])
  })

  it('an official Node loads only system libraries: nothing to check', () => {
    expect(loadPaths(linkedLibraries(macho64()), '/x/bin/node')).toEqual([])
    expect(loadPaths(linkedLibraries(elf64()), '/x/bin/node')).toEqual(['/lib64/ld-linux-x86-64.so.2'])
  })

  it('refuses what cannot be judged: other formats, relative or unexpanded search paths, truncated files', () => {
    expect(() => linkedLibraries(Buffer.from('#!/bin/sh\necho hi\n'.padEnd(64)))).toThrow(
      /not an ELF or Mach-O/,
    )
    expect(() => loadPaths(linkedLibraries(elf64({ runpath: 'lib' })), '/x/node')).toThrow(
      /cannot be checked/,
    )
    expect(() => loadPaths(linkedLibraries(elf64({ runpath: '$LIB/x' })), '/x/node')).toThrow(
      /cannot be checked/,
    )
    expect(() => loadPaths(linkedLibraries(elf64({ needed: ['lib/x.so'] })), '/x/node')).toThrow(
      /working directory/,
    )
    expect(() => linkedLibraries(elf64().subarray(0, 300))).toThrow(/could not be read/)
  })
})
