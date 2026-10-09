/**
 * Fan-out. Many clients, each subscribed to some streams; one upstream
 * subscription per stream however many are watching it.
 *
 * A stream nobody is watching stays subscribed for a while (the linger), so a
 * person switching between two timeframes does not spend the venue's request
 * budget on every switch, and the next viewer gets a snapshot from memory.
 *
 * Clients speak the venue's own subscribe frame (`mt: 5`) and get its ack
 * (`mt: 6`) back. Every data frame carries a `stream` field with the name.
 */

import type { Logger } from './log';
import {
  MT,
  createStreamState,
  parseStream,
  tagFrame,
  tagSnapshot,
  type ParsedStream,
  type StreamState,
} from './streams';

export interface HubClient {
  send(text: string): void;
}

/** The part of the upstream pool the hub drives. */
export interface StreamSource {
  want(stream: string): boolean;
  unwant(stream: string): void;
}

export interface HubOptions {
  chainId: number;
  source: StreamSource;
  log: Logger;
  /**
   * True or false once the venue's market list is loaded; null before that, in
   * which case the venue is left to judge the id.
   */
  isKnownMarket(marketId: number): boolean | null;
  /** Streams kept subscribed whether or not anyone is watching. */
  pinned?: readonly string[];
  lingerMs?: number;
  maxSubsPerClient?: number;
}

interface Topic {
  parsed: ParsedStream;
  state: StreamState;
  clients: Set<HubClient>;
  /** The serialised snapshot, reused until the next frame changes the state. */
  snapshotText: string | null;
  linger: ReturnType<typeof setTimeout> | null;
  pinned: boolean;
  idleSince: number;
}

interface SubStatus {
  stream: string;
  status: { code: number; error?: string };
}

const refused = (stream: unknown, code: number, error: string): SubStatus => ({
  stream: typeof stream === 'string' ? stream.slice(0, 64) : '',
  status: { code, error },
});

export class Hub {
  private readonly topics = new Map<string, Topic>();
  private readonly subsByClient = new Map<HubClient, Set<string>>();
  private readonly lingerMs: number;
  private readonly maxSubsPerClient: number;

  constructor(private readonly opts: HubOptions) {
    this.lingerMs = opts.lingerMs ?? 300_000;
    this.maxSubsPerClient = opts.maxSubsPerClient ?? 32;
    for (const raw of opts.pinned ?? []) {
      const parsed = parseStream(raw, opts.chainId);
      if (!parsed) {
        opts.log({ level: 'warn', event: 'pinned_stream_invalid', stream: raw });
        continue;
      }
      if (this.topics.has(parsed.name)) continue;
      if (!opts.source.want(parsed.name)) {
        opts.log({ level: 'warn', event: 'pinned_stream_no_capacity', stream: parsed.name });
        continue;
      }
      this.topics.set(parsed.name, this.newTopic(parsed, true));
    }
  }

  private newTopic(parsed: ParsedStream, pinned: boolean): Topic {
    return {
      parsed,
      state: createStreamState(parsed.kind),
      clients: new Set(),
      snapshotText: null,
      linger: null,
      pinned,
      idleSince: Date.now(),
    };
  }

  /** A frame from the venue: fold it into the stream's state and relay it. */
  onFrame(stream: string, frame: Record<string, unknown>, raw: string): void {
    const topic = this.topics.get(stream);
    if (!topic) return;
    topic.state.apply(frame);
    topic.snapshotText = null;
    if (topic.clients.size === 0) return;
    const text = tagFrame(stream, raw);
    for (const client of topic.clients) client.send(text);
  }

  /** The venue refused a stream. Tell whoever asked and forget it. */
  onRejected(stream: string, code: number, error: string): void {
    const topic = this.topics.get(stream);
    if (!topic) return;
    if (topic.linger) clearTimeout(topic.linger);
    this.topics.delete(stream);
    const text = JSON.stringify({ mt: MT.subscribeAck, subs: [{ stream, status: { code, error } }] });
    for (const client of topic.clients) {
      this.subsByClient.get(client)?.delete(stream);
      client.send(text);
    }
  }

  /**
   * Handles one `mt: 5` frame from a client: answers with `mt: 6`, then sends a
   * snapshot for each new subscription that already has one in memory.
   */
  request(client: HubClient, subs: unknown): void {
    if (!Array.isArray(subs) || subs.length === 0 || subs.length > this.maxSubsPerClient) {
      client.send(JSON.stringify({ mt: MT.subscribeAck, subs: [refused('', 400, 'subs must be a non-empty array')] }));
      return;
    }
    const results: SubStatus[] = [];
    const joined: Topic[] = [];
    for (const entry of subs as Array<{ stream?: unknown; subscribe?: unknown }>) {
      const raw = entry?.stream;
      const parsed = parseStream(raw, this.opts.chainId);
      if (!parsed) {
        results.push(refused(raw, 404, 'unknown stream'));
        continue;
      }
      if (entry.subscribe === false) {
        this.leave(client, parsed.name);
        results.push({ stream: parsed.name, status: { code: 0 } });
        continue;
      }
      const result = this.join(client, parsed);
      results.push(result.status);
      if (result.joined) joined.push(result.joined);
    }
    client.send(JSON.stringify({ mt: MT.subscribeAck, subs: results }));
    for (const topic of joined) {
      const text = this.snapshotText(topic);
      if (text !== null) client.send(text);
    }
  }

  private snapshotText(topic: Topic): string | null {
    if (topic.snapshotText === null) {
      const frame = topic.state.snapshot();
      if (frame === null) return null;
      topic.snapshotText = tagSnapshot(topic.parsed.name, frame);
    }
    return topic.snapshotText;
  }

  private join(client: HubClient, parsed: ParsedStream): { status: SubStatus; joined?: Topic } {
    const { name } = parsed;
    let mine = this.subsByClient.get(client);
    if (mine?.has(name)) return { status: { stream: name, status: { code: 0 } } };
    if (mine && mine.size >= this.maxSubsPerClient) {
      return { status: refused(name, 429, 'too many subscriptions') };
    }

    let topic = this.topics.get(name);
    if (!topic) {
      if (parsed.marketId !== undefined && this.opts.isKnownMarket(parsed.marketId) === false) {
        return { status: refused(name, 404, 'unknown stream') };
      }
      if (!this.opts.source.want(name) && !(this.evictIdle() && this.opts.source.want(name))) {
        return { status: refused(name, 429, 'gateway is at its stream capacity') };
      }
      topic = this.newTopic(parsed, false);
      this.topics.set(name, topic);
    }
    if (topic.linger) clearTimeout(topic.linger);
    topic.linger = null;
    topic.clients.add(client);
    if (!mine) {
      mine = new Set();
      this.subsByClient.set(client, mine);
    }
    mine.add(name);
    return { status: { stream: name, status: { code: 0 } }, joined: topic };
  }

  private leave(client: HubClient, name: string): void {
    const mine = this.subsByClient.get(client);
    if (!mine?.delete(name)) return;
    const topic = this.topics.get(name);
    if (!topic) return;
    topic.clients.delete(client);
    if (topic.clients.size > 0 || topic.pinned) return;
    topic.idleSince = Date.now();
    topic.linger = setTimeout(() => this.drop(name), this.lingerMs);
  }

  private drop(name: string): void {
    const topic = this.topics.get(name);
    if (!topic || topic.clients.size > 0 || topic.pinned) return;
    if (topic.linger) clearTimeout(topic.linger);
    this.topics.delete(name);
    this.opts.source.unwant(name);
  }

  /** Frees the stream that has gone unwatched longest. False if every stream is in use. */
  private evictIdle(): boolean {
    let oldest: Topic | null = null;
    for (const topic of this.topics.values()) {
      if (topic.pinned || topic.clients.size > 0) continue;
      if (!oldest || topic.idleSince < oldest.idleSince) oldest = topic;
    }
    if (!oldest) return false;
    this.drop(oldest.parsed.name);
    return true;
  }

  /** A client disconnected. */
  remove(client: HubClient): void {
    const mine = this.subsByClient.get(client);
    if (!mine) return;
    for (const name of [...mine]) this.leave(client, name);
    this.subsByClient.delete(client);
  }

  stats(): { subscribers: number; streams: number; watched: number } {
    let watched = 0;
    for (const topic of this.topics.values()) if (topic.clients.size > 0) watched++;
    return { subscribers: this.subsByClient.size, streams: this.topics.size, watched };
  }

  close(): void {
    for (const topic of this.topics.values()) if (topic.linger) clearTimeout(topic.linger);
    this.topics.clear();
    this.subsByClient.clear();
  }
}
