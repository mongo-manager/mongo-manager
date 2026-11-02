import { createWriteStream, type WriteStream } from 'node:fs'
import { once } from 'node:events'
import type { ExportFormat } from '@mongo-manager/shared'
import type { TransferFile, TransferFiles } from './files'
import { csvLine } from './formats/csv'
import { XlsxWriter } from './formats/xlsx'
import type { Cell, Delimiter, OutCell } from './formats/types'

const cellOut = (c: Cell): OutCell =>
  c === null
    ? { t: 'empty' }
    : typeof c === 'string'
      ? { t: 'text', v: c }
      : typeof c === 'number'
        ? { t: 'num', v: c }
        : typeof c === 'boolean'
          ? { t: 'bool', v: c }
          : { t: 'date', v: c }

/** How much the file grows between two looks at the quota. */
const CHECK_EVERY = 64 * 1024

/**
 * Spec §4.2, §6.3: the refused records, in the source's format, written while the job runs. Table
 * rows are written from their cells, document records from their text; a record that could not be
 * read at all (no cells, no text) has nothing to write back. The file counts against its owner's
 * quota as it grows; one that would pass it is dropped and the import goes on (final review I6).
 */
export class RejectedWriter {
  private file?: TransferFile
  private out?: WriteStream
  private xlsx?: XlsxWriter
  private count = 0
  private checked = 0
  /** The file passed the quota and was deleted; later records are not written. */
  dropped = false

  constructor(
    private readonly input: {
      files: TransferFiles
      owner: string
      connectionId: string
      jobId: string
      format: ExportFormat
      header: string[] | null
      name: string
      /** The source's delimiter, for a CSV file (data review 2026-10-13); a comma when not given. */
      delimiter?: Delimiter
    },
  ) {}

  private async put(text: string): Promise<void> {
    if (!this.out!.write(text)) await once(this.out!, 'drain')
  }

  private async open(): Promise<void> {
    const { file, path } = this.input.files.reserve({
      owner: this.input.owner,
      kind: 'rejected',
      connectionId: this.input.connectionId,
      name: `${this.input.name.replace(/\.[^.]*$/, '')}-rejected`,
      jobId: this.input.jobId,
      format: this.input.format,
    })
    this.file = file
    this.out = createWriteStream(path, { flags: 'wx', mode: 0o600 })
    const header = this.input.header?.map((v): OutCell => ({ t: 'text', v })) ?? null
    if (this.input.format === 'xlsx') {
      this.xlsx = new XlsxWriter(this.out)
      await this.xlsx.start()
      if (header) await this.xlsx.row(header)
    } else if (this.input.format === 'csv' && header)
      await this.put(csvLine(header, this.input.delimiter ?? ',', '\r\n', { guard: false }))
    else if (this.input.format === 'json') await this.put('[\n')
  }

  /** Records the file's size; past the quota it is deleted. Whether it is still kept. */
  private async keep(final: boolean): Promise<boolean> {
    const size = this.out!.bytesWritten + this.out!.writableLength
    if (!final && size - this.checked < CHECK_EVERY) return true
    this.checked = size
    this.input.files.grow(this.file!.id, size)
    if (this.input.files.room(this.input.owner) >= 0) return true
    await this.abort()
    this.dropped = true
    return false
  }

  async write(rec: { cells?: Cell[]; raw?: string }): Promise<void> {
    if (this.dropped || (!rec.cells && rec.raw === undefined)) return
    if (!this.file) await this.open()
    if (rec.cells) {
      if (this.xlsx) await this.xlsx.row(rec.cells.map(cellOut))
      else
        await this.put(csvLine(rec.cells.map(cellOut), this.input.delimiter ?? ',', '\r\n', { guard: false }))
    } else if (this.input.format === 'json') await this.put(`${this.count ? ',\n' : ''}${rec.raw}`)
    else await this.put(`${rec.raw}\n`)
    this.count++
    await this.keep(false)
  }

  /** Completes the file; whether there is one. */
  async finish(): Promise<boolean> {
    if (!this.file) return false
    if (this.xlsx) await this.xlsx.finish()
    else if (this.input.format === 'json') await this.put('\n]\n')
    await new Promise<void>((resolve, reject) =>
      this.out!.end((e?: Error | null) => (e ? reject(e) : resolve())),
    )
    if (!(await this.keep(true))) return false
    this.input.files.complete(this.file.id, this.out!.bytesWritten)
    return true
  }

  async abort(): Promise<void> {
    if (!this.file) return
    this.out?.destroy()
    this.input.files.delete(this.input.owner, this.file.id)
    this.file = undefined
  }
}
