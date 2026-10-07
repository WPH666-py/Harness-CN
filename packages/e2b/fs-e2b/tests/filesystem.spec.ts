import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { FileNotFoundError, FileType } from '@deepseek-ai/dsh-e2b'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { describe, expect, it, vi } from 'vitest'
import { FakeRemote, bytes, commandError } from './fake-remote.ts'
import { expectCode, setup } from './harness.ts'

describe('E2BFileSystem identity, metadata, and reads', () => {
  it('resolves remote paths, reports symlinks, and lists direct children in stable order', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/z.txt', 'z')
    remote.file('/workspace/a.txt', 'a')
    remote.dir('/workspace/dir')
    remote.other('/workspace/special')
    remote.file('/workspace/dir/nested.txt', 'nested')
    remote.symlink('/workspace/link.txt', '/workspace/a.txt')
    const { fs } = await setup(remote)

    const link = await fs.resolve('link.txt')
    expect(link).toEqual({ targetKey: '/workspace/a.txt', displayPath: '/workspace/link.txt' })
    await expect(fs.lstat('link.txt')).resolves.toMatchObject({ type: 'symlink', size: 1 })
    await expect(fs.lstat('a.txt')).resolves.toMatchObject({ type: 'file', size: 1 })
    await expect(fs.lstat('dir')).resolves.toEqual(expect.objectContaining({ type: 'directory' }))
    await expect(fs.lstat('special')).resolves.toEqual(expect.objectContaining({ type: 'other' }))
    await expect(fs.lstat('missing')).resolves.toBeUndefined()
    await expect(fs.stat(link)).resolves.toMatchObject({ type: 'file', size: 1 })
    const directory = await fs.resolve('.')
    const listed = await fs.listDir(directory)
    expect(listed.map(entry => entry.name)).toEqual(['a.txt', 'dir', 'link.txt', 'special', 'z.txt'])
    expect(listed.find(entry => entry.name === 'dir')).toMatchObject({ type: 'directory' })
    expect(listed.find(entry => entry.name === 'link.txt')).toMatchObject({
      type: 'file',
      target: { targetKey: '/workspace/a.txt', displayPath: '/workspace/link.txt' },
    })
    expect(listed.some(entry => entry.name === 'nested.txt')).toBe(false)
  })

  it('projects canonical process paths, file URLs, and containment', async () => {
    const remote = new FakeRemote()
    remote.dir('/workspace/nested')
    remote.file('/workspace/nested/multibyte # file.ts', 'text')
    remote.file('/outside.ts', 'outside')
    const { fs } = await setup(remote)
    const workspace = await fs.resolve('/workspace')
    const nested = await fs.resolve('/workspace/nested/multibyte # file.ts')
    const outside = await fs.resolve('/outside.ts')

    expect(fs.processPath(nested)).toBe('/workspace/nested/multibyte # file.ts')
    expect(fs.processPathFromHostPath('/Users/alice/.dsh/attachments/object')).toBeUndefined()
    expect(fs.fileUrl(nested)).toBe('file:///workspace/nested/multibyte%20%23%20file.ts')
    expect(fs.contains(workspace, workspace)).toBe(true)
    expect(fs.contains(workspace, nested)).toBe(true)
    expect(fs.contains(nested, workspace)).toBe(false)
    expect(fs.contains(workspace, outside)).toBe(false)
    expect(() => fs.fileUrl({ targetKey: FsTargetKey('relative'), displayPath: 'relative' }))
      .toThrow('expected an absolute process path')
  })

  it('preserves newline and multibyte canonical paths through strict ASCII framing', async () => {
    const remote = new FakeRemote()
    const path = '/workspace/你好\nfile.ts'
    remote.file(path, 'text')
    const { fs } = await setup(remote)

    await expect(fs.resolve(path)).resolves.toEqual({ targetKey: path, displayPath: path })
  })

  it.each([
    ['invalid base64', '!!!!'],
    ['missing terminator', Buffer.from('/workspace/file').toString('base64')],
    ['multiple records', Buffer.from('/workspace/file\0/other\0').toString('base64')],
    ['invalid UTF-8', Buffer.from([47, 0xff, 0]).toString('base64')],
    ['relative path', Buffer.from('workspace/file\0').toString('base64')],
  ])('rejects %s from canonical path transport', async (_label, output) => {
    const remote = new FakeRemote()
    remote.canonicalOutput = output
    const { fs } = await setup(remote)
    await expectCode(fs.resolve('file'), 'FS_IO_ERROR')
  })

  it('reads whole and streamed UTF-8 across chunk boundaries', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/text.txt', 'A€B')
    remote.streamChunks = [bytes([65, 0xe2]), bytes([0x82, 0xac, 66])]
    const { fs } = await setup(remote)
    const target = await fs.resolve('text.txt')
    await expect(fs.readText(target)).resolves.toBe('A€B')
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe('A€B')

    remote.streamChunks = [bytes([0xe2]), bytes([0x82, 0xac])]
    let initiallyBuffered = ''
    for await (const chunk of await fs.streamText(target)) initiallyBuffered += chunk
    expect(initiallyBuffered).toBe('€')
  })

  it('streams an empty file even though the pinned SDK returns a non-stream value', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/empty.txt', '')
    const { fs } = await setup(remote)
    let streamed = ''
    for await (const chunk of await fs.streamText(await fs.resolve('empty.txt'))) streamed += chunk
    expect(streamed).toBe('')
  })

  it('cancels a remote stream when its consumer stops early', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/text.txt', 'ab')
    remote.streamChunks = [bytes('a'), bytes('b')]
    remote.streamKeepOpen = true
    const { fs } = await setup(remote)
    const stream = await fs.streamText(await fs.resolve('text.txt'))

    for await (const chunk of stream) {
      expect(chunk).toBe('a')
      break
    }

    expect(remote.streamCancel).toHaveBeenCalledOnce()
  })

  it('matches local binary sampling while edits still reject any NUL byte', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/late-nul.txt', `${'a'.repeat(8192)}\0tail`)
    const { fs } = await setup(remote)
    const target = await fs.resolve('late-nul.txt')
    await expect(fs.readText(target)).resolves.toContain('\0tail')
    remote.streamChunks = [bytes('a'.repeat(8192)), bytes([0, 116])]
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe(`${'a'.repeat(8192)}\0t`)
    await expectCode(fs.editText(target, { oldString: 'tail', newString: 'end', replaceAll: false }), 'FS_NOT_TEXT')
  })

  it('maps binary, invalid UTF-8, missing, and non-regular read failures', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/binary', [0, 1])
    remote.file('/workspace/invalid', [0xff])
    remote.dir('/workspace/directory')
    const { fs } = await setup(remote)
    await expectCode(fs.readText(await fs.resolve('binary')), 'FS_NOT_TEXT')
    await expectCode(fs.readText(await fs.resolve('invalid')), 'FS_NOT_TEXT')
    await expectCode(fs.readText(await fs.resolve('missing')), 'FS_NOT_FOUND')
    await expectCode(fs.readText(await fs.resolve('directory')), 'FS_NOT_REGULAR_FILE')

    remote.streamChunks = [bytes([0xff])]
    const invalid = await fs.streamText(await fs.resolve('invalid'))
    await expect((async () => { for await (const _chunk of invalid) void _chunk })()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    remote.streamChunks = [bytes([0])]
    const binary = await fs.streamText(await fs.resolve('binary'))
    await expect((async () => { for await (const _chunk of binary) void _chunk })()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })

    remote.streamChunks = [bytes([0xe2])]
    const incomplete = await fs.streamText(await fs.resolve('invalid'))
    await expect((async () => { for await (const _chunk of incomplete) void _chunk })()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })

    const raced = await fs.resolve('invalid')
    remote.nextReadError = new FileNotFoundError('gone after stat')
    await expectCode(fs.streamText(raced), 'FS_NOT_FOUND')
  })

  it('readBytes returns raw content, enforces the byte cap, and maps failures', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/img.bin', [0x89, 0, 0xff, 0x47])
    remote.dir('/workspace/directory')
    const { fs } = await setup(remote)
    const target = await fs.resolve('img.bin')
    expect(Array.from(await fs.readBytes(target, undefined, 4))).toEqual([0x89, 0, 0xff, 0x47])
    expect(remote.reads).toEqual([{ path: '/workspace/img.bin', format: 'stream' }])
    remote.reads.length = 0
    await expectCode(fs.readBytes(target, undefined, 3), 'FS_TOO_LARGE')
    expect(remote.reads).toEqual([])
    await expectCode(fs.readBytes(await fs.resolve('missing'), undefined, 4), 'FS_NOT_FOUND')
    await expectCode(fs.readBytes(await fs.resolve('directory'), undefined, 4), 'FS_NOT_REGULAR_FILE')

    const live = new AbortController()
    expect((await fs.readBytes(target, live.signal, 4)).byteLength).toBe(4)
    remote.nextReadError = new DOMException('aborted', 'AbortError')
    await expectCode(fs.readBytes(target, undefined, 4), 'FS_ABORTED')
  })

  it('readBytes bounds a post-stat grower mid-stream and reads an empty file through the SDK quirk', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/grow.bin', [1, 1, 1, 1])
    remote.file('/workspace/empty.bin', '')
    const { fs } = await setup(remote)

    remote.streamChunks = [bytes([1, 1, 1]), bytes([1, 2, 2])]
    remote.streamKeepOpen = true
    await expectCode(fs.readBytes(await fs.resolve('grow.bin'), undefined, 4), 'FS_TOO_LARGE')
    expect(remote.streamCancel).toHaveBeenCalledOnce()

    remote.streamChunks = undefined
    remote.streamKeepOpen = false
    expect((await fs.readBytes(await fs.resolve('empty.bin'), undefined, 4)).byteLength).toBe(0)
  })

  it('readByteRange skips to the offset, keeps the window, and cancels the stream there', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/ramp.bin', [1, 2, 3, 4, 5, 6, 7, 8, 9])
    const { fs } = await setup(remote)
    const target = await fs.resolve('ramp.bin')
    remote.streamChunks = [bytes([1, 2, 3]), bytes([4, 5, 6]), bytes([7, 8, 9])]
    remote.streamKeepOpen = true
    expect(Array.from(await fs.readByteRange(target, { offset: 4, length: 3 }))).toEqual([5, 6, 7])
    expect(remote.reads).toEqual([{ path: '/workspace/ramp.bin', format: 'stream' }])
    expect(remote.streamCancel).toHaveBeenCalledOnce()
  })

  it('readByteRange shortens at the end, empties past it, and skips the read for length 0', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/ramp.bin', [1, 2, 3, 4, 5, 6, 7, 8, 9])
    remote.dir('/workspace/directory')
    const { fs } = await setup(remote)
    const target = await fs.resolve('ramp.bin')
    remote.streamChunks = [bytes([1, 2, 3]), bytes([4, 5, 6]), bytes([7, 8, 9])]
    expect(Array.from(await fs.readByteRange(target, { offset: 7, length: 10 }))).toEqual([8, 9])
    expect(remote.streamCancel).not.toHaveBeenCalled()
    expect((await fs.readByteRange(target, { offset: 9, length: 2 })).byteLength).toBe(0)
    remote.reads.length = 0
    expect((await fs.readByteRange(target, { offset: 0, length: 0 })).byteLength).toBe(0)
    expect(remote.reads).toEqual([])
    await expectCode(fs.readByteRange(await fs.resolve('missing'), { offset: 0, length: 1 }), 'FS_NOT_FOUND')
    await expectCode(fs.readByteRange(await fs.resolve('directory'), { offset: 0, length: 1 }), 'FS_NOT_REGULAR_FILE')
  })

  it('readByteRange maps a failing open, an abort mid-stream, and tolerates a failing cancel', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/ramp.bin', [1, 2, 3, 4])
    const { fs } = await setup(remote)
    const target = await fs.resolve('ramp.bin')
    remote.nextReadError = new DOMException('aborted', 'AbortError')
    await expectCode(fs.readByteRange(target, { offset: 0, length: 2 }), 'FS_ABORTED')

    // The window wants more than the one chunk delivered; the abort fails the open stream.
    remote.streamChunks = [bytes([1])]
    remote.streamKeepOpen = true
    const controller = new AbortController()
    const pending = fs.readByteRange(target, { offset: 0, length: 4 }, controller.signal)
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    controller.abort()
    await expectCode(pending, 'FS_ABORTED')

    remote.streamChunks = [bytes([1, 2, 3, 4])]
    remote.streamCancel.mockRejectedValueOnce(new Error('cancel failed'))
    expect(Array.from(await fs.readByteRange(target, { offset: 1, length: 2 }))).toEqual([2, 3])
  })

  it('honors aborts before and during remote reads', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/a', 'a')
    const { fs } = await setup(remote)
    await expectCode(fs.resolve('a', { signal: AbortSignal.abort() }), 'FS_ABORTED')
    await expectCode(fs.lstat('a', undefined, AbortSignal.abort()), 'FS_ABORTED')
    await expectCode(fs.stat(await fs.resolve('a'), AbortSignal.abort()), 'FS_ABORTED')
    remote.nextReadError = new DOMException('aborted', 'AbortError')
    await expectCode(fs.readText(await fs.resolve('a')), 'FS_ABORTED')
  })

  it('rejects empty paths and directory-listing type errors', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file', 'x')
    const { fs } = await setup(remote)
    await expectCode(fs.resolve('   '), 'FS_NOT_FOUND')
    await expectCode(fs.lstat(''), 'FS_NOT_FOUND')
    await expectCode(fs.listDir(await fs.resolve('missing')), 'FS_NOT_FOUND')
    await expectCode(fs.listDir(await fs.resolve('/workspace/file')), 'FS_NOT_DIRECTORY')
    remote.nextListError = new Error('listing transport failed')
    await expectCode(fs.listDir(await fs.resolve('/workspace')), 'FS_IO_ERROR')
  })
})

describe('E2BFileSystem atomic writes and edits', () => {
  it('creates owner-only files and returns metadata after the committed move', async () => {
    const { fs, remote } = await setup()
    const target = await fs.resolve('new.txt')
    const outcome = await fs.writeText(target, 'one\r\ntwo\rthree', { kind: 'createIfAbsent' })
    expect(outcome).toMatchObject({ operation: 'create', before: null, after: 'one\ntwo\rthree' })
    expect(remote.nodes.get('/workspace/new.txt')?.mode).toBe(0o600)
    expect(remote.nodes.get('/workspace/new.txt')?.metadata?.['dsh-version']).toBeDefined()
    expect(remote.writeParentModes).toEqual([0o700])
    expect(remote.links).toHaveLength(1)
    const stagingDirectory = posix.dirname(remote.writes[0]!.path)
    expect(posix.dirname(stagingDirectory)).toBe('/workspace')
    expect(remote.removals).toContain(stagingDirectory)
    await expect(fs.stat(target)).resolves.toMatchObject({ version: outcome.version, size: 14 })
  })

  it('preserves replacement mode, normalizes only CRLF for diffs, and changes version on external writes', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', 'old\r\nline\rlone', 0o640)
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    const before = (await fs.stat(target))!.version
    const outcome = await fs.writeText(target, 'new', { kind: 'replaceIfVersion', version: before })
    expect(outcome).toMatchObject({ operation: 'update', before: 'old\nline\rlone', after: 'new' })
    expect(remote.nodes.get('/workspace/file.txt')?.mode).toBe(0o640)
    const committed = outcome.version
    remote.mutate('/workspace/file.txt', 'external')
    expect((await fs.stat(target))!.version).not.toBe(committed)
  })

  it('returns null as the overwrite diff basis for binary or invalid prior content', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', [0xff])
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    await expect(fs.writeText(target, 'valid')).resolves.toMatchObject({ before: null, after: 'valid' })
  })

  it('fails an overwrite when reading its text diff basis fails for another reason', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', 'prior')
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    remote.nextReadError = new Error('read transport failed')
    await expectCode(fs.writeText(target, 'replacement'), 'FS_IO_ERROR')
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/file.txt')?.data)).toBe('prior')
  })

  it('enforces create and version intents before publication', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', 'v1')
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    const version = (await fs.stat(target))!.version
    await expectCode(fs.writeText(target, 'blind', { kind: 'createIfAbsent' }), 'FS_NOT_OBSERVED')
    remote.mutate('/workspace/file.txt', 'v2')
    await expectCode(fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version }), 'FS_STALE_VERSION')
    await expectCode(fs.writeText(await fs.resolve('missing'), 'stale', { kind: 'replaceIfVersion', version }), 'FS_STALE_VERSION')
    remote.dir('/workspace/dir')
    await expectCode(fs.writeText(await fs.resolve('dir'), 'x'), 'FS_NOT_REGULAR_FILE')
  })

  it('preserves a competitor created after the guarded-create probe', async () => {
    const remote = new FakeRemote()
    remote.competitorBeforeLink = { path: '/workspace/race.txt', kind: 'file', data: 'competitor' }
    const { fs } = await setup(remote)

    await expectCode(
      fs.writeText(await fs.resolve('race.txt'), 'ours', { kind: 'createIfAbsent' }),
      'FS_NOT_OBSERVED',
    )
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/race.txt')?.data)).toBe('competitor')
    expect(remote.links).toHaveLength(0)
    expect(remote.removals).toHaveLength(1)
  })

  it('preserves a competing directory during guarded-create publication', async () => {
    const remote = new FakeRemote()
    remote.competitorBeforeLink = { path: '/workspace/race-dir', kind: 'directory' }
    const { fs } = await setup(remote)

    await expectCode(
      fs.writeText(await fs.resolve('race-dir'), 'ours', { kind: 'createIfAbsent' }),
      'FS_NOT_OBSERVED',
    )
    expect(remote.nodes.get('/workspace/race-dir')?.type).toBe(FileType.DIR)
    expect(remote.nodes.has('/workspace/race-dir/content')).toBe(false)
    expect(remote.links).toHaveLength(0)
    expect(remote.removals).toHaveLength(1)
  })

  it('rejects an invalid guarded-create publication response before claiming success', async () => {
    const remote = new FakeRemote()
    remote.guardedLinkOutput = 'unexpected'
    const { fs } = await setup(remote)

    await expectCode(
      fs.writeText(await fs.resolve('invalid.txt'), 'ours', { kind: 'createIfAbsent' }),
      'FS_IO_ERROR',
    )
    expect(remote.nodes.has('/workspace/invalid.txt')).toBe(false)
    expect(remote.removals).toHaveLength(1)
  })

  it('does not turn an abort observed after a successful move into a failed write', async () => {
    const remote = new FakeRemote()
    const controller = new AbortController()
    remote.abortAfterRename = controller
    const { fs } = await setup(remote)
    await expect(fs.writeText(await fs.resolve('committed'), 'yes', undefined, controller.signal))
      .resolves.toMatchObject({ operation: 'create' })
    expect(controller.signal.aborted).toBe(true)
  })

  it('does not turn an abort observed after a guarded create into a failed write', async () => {
    const remote = new FakeRemote()
    const controller = new AbortController()
    remote.abortAfterRename = controller
    const { fs } = await setup(remote)
    await expect(fs.writeText(
      await fs.resolve('committed-create'),
      'yes',
      { kind: 'createIfAbsent' },
      controller.signal,
    )).resolves.toMatchObject({ operation: 'create' })
    expect(controller.signal.aborted).toBe(true)
  })

  it('does not turn post-commit staging cleanup failure into a failed write', async () => {
    const remote = new FakeRemote()
    remote.nextRemoveError = new Error('empty staging cleanup failed')
    const { fs } = await setup(remote)
    await expect(fs.writeText(await fs.resolve('committed'), 'yes'))
      .resolves.toMatchObject({ operation: 'create' })
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/committed')?.data)).toBe('yes')
  })

  it('returns committed rename metadata without a fallible post-commit lookup', async () => {
    const remote = new FakeRemote()
    const getInfo = vi.spyOn(remote.sandbox.files, 'getInfo')
    const { fs } = await setup(remote)

    await expect(fs.writeText(await fs.resolve('committed'), 'yes'))
      .resolves.toMatchObject({ operation: 'create' })
    expect(getInfo).toHaveBeenCalledTimes(1)
    expect(remote.renames).toHaveLength(1)
  })

  it('cleans staging files and maps command, permission, and abort failures', async () => {
    const remote = new FakeRemote()
    const { fs } = await setup(remote)
    const commandTarget = await fs.resolve('command')
    remote.nextCommandError = commandError(1, 'chmod failed')
    await expectCode(fs.writeText(commandTarget, 'x'), 'FS_IO_ERROR')
    expect(remote.removals).toHaveLength(1)

    remote.nextRenameError = new Error('permission denied')
    await expectCode(fs.writeText(await fs.resolve('permission'), 'x'), 'FS_PERMISSION_DENIED')
    remote.nextRemoveError = new Error('cleanup also failed')
    remote.nextRenameError = new DOMException('aborted', 'AbortError')
    await expectCode(fs.writeText(await fs.resolve('abort'), 'x'), 'FS_ABORTED')

    const removalsBeforeCollision = remote.removals.length
    remote.nextInfoError = new Error('info failed')
    await expectCode(fs.writeText(await fs.resolve('collision'), 'x'), 'FS_IO_ERROR')
    expect(remote.removals).toHaveLength(removalsBeforeCollision)
  })

  it('applies literal edits atomically and restores the detected CRLF style', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', 'one\r\ntwo\r\nthree\n')
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    const version = (await fs.stat(target))!.version
    const outcome = await fs.editText(
      target,
      { oldString: 'two\r\n', newString: 'TWO\r\n', replaceAll: false },
      { version },
    )
    expect(outcome).toMatchObject({ before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n' })
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/file.txt')?.data)).toBe('one\r\nTWO\r\nthree\r\n')
  })

  it('reports stale and literal-match failures with stable codes', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', 'a a')
    remote.dir('/workspace/dir')
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    await expectCode(fs.editText(target, { oldString: '', newString: 'x', replaceAll: false }), 'FS_EDIT_NOT_FOUND')
    await expectCode(fs.editText(target, { oldString: 'z', newString: 'x', replaceAll: false }), 'FS_EDIT_NOT_FOUND')
    await expectCode(fs.editText(target, { oldString: 'a', newString: 'x', replaceAll: false }), 'FS_AMBIGUOUS_EDIT')
    await expect(fs.editText(target, { oldString: 'a', newString: 'x', replaceAll: true }))
      .resolves.toMatchObject({ after: 'x x' })
    await expectCode(fs.editText(target, { oldString: 'x', newString: 'y', replaceAll: false }, { version: FsVersion('stale') }), 'FS_STALE_VERSION')
    await expectCode(fs.editText(await fs.resolve('missing'), { oldString: 'x', newString: 'y', replaceAll: false }), 'FS_STALE_VERSION')
    await expectCode(fs.editText(await fs.resolve('dir'), { oldString: 'x', newString: 'y', replaceAll: false }), 'FS_NOT_REGULAR_FILE')
  })

  it('serializes guarded mutations so only one stale version can win', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', 'base')
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    const version = (await fs.stat(target))!.version
    const results = await Promise.allSettled([
      fs.writeText(target, 'one', { kind: 'replaceIfVersion', version }),
      fs.editText(target, { oldString: 'base', newString: 'two', replaceAll: false }, { version }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
})

describe('E2B filesystem adapter integration edges', () => {
  it('maps canonicalization, permission, and generic provider failures', async () => {
    const remote = new FakeRemote()
    const { fs } = await setup(remote)
    remote.nextCommandError = commandError(1, 'not a directory')
    await expectCode(fs.resolve('bad'), 'FS_IO_ERROR')
    remote.nextCommandError = commandError(1)
    await expectCode(fs.resolve('bad-again'), 'FS_IO_ERROR')
    remote.nextCommandError = new Error('canonical transport failed')
    await expectCode(fs.resolve('bad-transport'), 'FS_IO_ERROR')
    remote.file('/workspace/a', 'a')
    const target = await fs.resolve('a')
    remote.nextInfoError = new Error('metadata transport failed')
    await expectCode(fs.stat(target), 'FS_IO_ERROR')
    remote.nextReadError = new Error('operation not permitted')
    await expectCode(fs.readText(target), 'FS_PERMISSION_DENIED')
    remote.nextReadError = 'transport vanished'
    await expectCode(fs.readText(target), 'FS_IO_ERROR')
  })

  it('uses listing metadata directly and canonicalizes only symbolic links', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/a', 'a')
    remote.file('/workspace/target', 'target')
    remote.file('/workspace/gone', 'gone')
    remote.symlink('/workspace/link', '/workspace/target')
    remote.symlink('/workspace/vanished-link', '/workspace/gone')
    remote.disappearOnInfo.add('/workspace/gone')
    const { fs } = await setup(remote)
    const directory = await fs.resolve('/workspace')
    const commandsBefore = remote.commands.length
    const getInfo = vi.spyOn(remote.sandbox.files, 'getInfo')

    const listed = await fs.listDir(directory)

    expect(listed.find(entry => entry.name === 'a')).toMatchObject({
      type: 'file', target: { targetKey: '/workspace/a' }, size: 1,
    })
    expect(listed.find(entry => entry.name === 'link')).toMatchObject({
      type: 'file', target: { targetKey: '/workspace/target' }, size: 6,
    })
    expect(listed.find(entry => entry.name === 'vanished-link')).toEqual({
      name: 'vanished-link',
      type: 'other',
      target: { targetKey: '/workspace/gone', displayPath: '/workspace/vanished-link' },
    })
    expect(remote.commands.slice(commandsBefore)).toHaveLength(2)
    expect(getInfo).toHaveBeenCalledTimes(3)
  })
})
