/**
 * Minimal streaming ZIP writer (deflate, UTF-8 names, data descriptors). One entry is open at a time;
 * every write awaits the file stream, so backpressure reaches the database cursor and memory stays bounded.
 * Used for XLSX containers and multi-part CSV/TSV/JSONL archives. Archives above 4 GiB are refused (no ZIP64).
 */
import {once} from 'node:events';
import type {Writable} from 'node:stream';
import zlib from 'node:zlib';

interface Entry { name: Buffer; crc: number; csize: number; usize: number; offset: number; time: number; date: number }
const LIMIT = 0xffffffff;
function dosDateTime(d = new Date()) {
  return {time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()};
}
export interface ZipEntry { write(chunk: string | Buffer): Promise<void>; close(): Promise<void> }

export class ZipWriter {
  private offset = 0;
  private entries: Entry[] = [];
  private open = false;
  constructor(private out: Writable) {}

  private async raw(buf: Buffer) {
    this.offset += buf.length;
    if (this.offset > LIMIT) throw new Error('ZIP_TOO_LARGE');
    if (!this.out.write(buf)) await once(this.out, 'drain');
  }

  async openEntry(name: string): Promise<ZipEntry> {
    if (this.open) throw new Error('ZIP_ENTRY_ALREADY_OPEN');
    this.open = true;
    const nameBuf = Buffer.from(name, 'utf8');
    const {time, date} = dosDateTime();
    const offset = this.offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0808, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10); header.writeUInt16LE(date, 12);
    header.writeUInt16LE(nameBuf.length, 26);
    await this.raw(header); await this.raw(nameBuf);
    let crc = 0, usize = 0, csize = 0;
    const deflate = zlib.createDeflateRaw({level: 6});
    const pending: Buffer[] = [];
    deflate.on('data', (d: Buffer) => { pending.push(d); });
    const flush = async () => { while (pending.length) { const d = pending.shift()!; csize += d.length; await this.raw(d); } };
    return {
      write: async (chunk) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        if (!buf.length) return;
        crc = zlib.crc32(buf, crc); usize += buf.length;
        if (usize > LIMIT) throw new Error('ZIP_ENTRY_TOO_LARGE');
        if (!deflate.write(buf)) await once(deflate, 'drain');
        await flush();
      },
      close: async () => {
        const ended = once(deflate, 'end');
        deflate.end(); await ended; await flush();
        const desc = Buffer.alloc(16);
        desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc >>> 0, 4); desc.writeUInt32LE(csize, 8); desc.writeUInt32LE(usize, 12);
        await this.raw(desc);
        this.entries.push({name: nameBuf, crc: crc >>> 0, csize, usize, offset, time, date});
        this.open = false;
      },
    };
  }

  async entry(name: string, content: string | Buffer) {
    const e = await this.openEntry(name); await e.write(content); await e.close();
  }

  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0808, 8); c.writeUInt16LE(8, 10);
      c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.usize, 24);
      c.writeUInt16LE(e.name.length, 28); c.writeUInt32LE(e.offset, 42);
      await this.raw(c); await this.raw(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12); end.writeUInt32LE(start, 16);
    await this.raw(end);
  }
}
