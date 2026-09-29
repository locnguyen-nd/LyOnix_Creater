import type { MediaJobChannel, MediaJobMessage, MediaJobPublishOptions } from "./transport.js";

/**
 * In-memory stand-in for RabbitMQ, for unit tests only (exported via
 * `@lyonix/media-jobs/testing`, never imported by runtime code). Supports the
 * `MediaJobChannel` surface: durable/exclusive queues, consume with/without ack,
 * nack-with-requeue (marks `redelivered`), and per-message properties.
 */
type Consumer = { tag: string; noAck: boolean; onMessage: (message: MediaJobMessage | null) => void; channel: InMemoryChannel };
type QueueState = { name: string; ready: MediaJobMessage[]; consumers: Consumer[]; nextConsumer: number };

export class InMemoryMediaJobBroker {
  private readonly queues = new Map<string, QueueState>();
  private tagSeq = 0;
  private anonSeq = 0;
  readonly published: Array<{ queue: string; content: Buffer; options: MediaJobPublishOptions }> = [];

  createChannel(): InMemoryChannel {
    return new InMemoryChannel(this);
  }

  /** Messages currently waiting (not delivered) on a queue. */
  depth(queue: string): number {
    return this.queues.get(queue)?.ready.length ?? 0;
  }

  /** @internal */
  ensureQueue(name: string): string {
    const resolved = name || `amq.gen-${++this.anonSeq}`;
    if (!this.queues.has(resolved)) this.queues.set(resolved, { name: resolved, ready: [], consumers: [], nextConsumer: 0 });
    return resolved;
  }

  /** @internal */
  publish(queue: string, content: Buffer, options: MediaJobPublishOptions, redelivered = false): void {
    const state = this.queues.get(queue);
    if (!redelivered) this.published.push({ queue, content, options });
    if (!state) return; // unroutable: dropped, like the default exchange with no queue
    state.ready.push({
      content,
      fields: { deliveryTag: ++this.tagSeq, redelivered },
      properties: { correlationId: options.correlationId, replyTo: options.replyTo, messageId: options.messageId, type: options.type },
    });
    this.dispatch(state);
  }

  /** @internal */
  addConsumer(queue: string, consumer: Omit<Consumer, "tag">): string {
    const state = this.queues.get(queue);
    if (!state) throw new Error(`NOT_FOUND - no queue '${queue}'`);
    const tag = `ctag-${++this.tagSeq}`;
    state.consumers.push({ ...consumer, tag });
    this.dispatch(state);
    return tag;
  }

  /** @internal */
  requeue(queue: string, message: MediaJobMessage): void {
    this.publish(queue, message.content, {
      ...(message.properties.correlationId ? { correlationId: message.properties.correlationId } : {}),
      ...(message.properties.replyTo ? { replyTo: message.properties.replyTo } : {}),
      ...(message.properties.messageId ? { messageId: message.properties.messageId } : {}),
      ...(message.properties.type ? { type: message.properties.type } : {}),
    }, true);
  }

  private dispatch(state: QueueState): void {
    queueMicrotask(() => {
      while (state.ready.length > 0) {
        const available = state.consumers.filter((c) => !c.channel.isClosed && c.channel.canAccept(c.noAck));
        if (available.length === 0) return;
        const consumer = available[state.nextConsumer++ % available.length]!;
        const message = state.ready.shift()!;
        if (!consumer.noAck) consumer.channel.track(message, state.name);
        consumer.onMessage(message);
      }
    });
  }

  /** @internal re-run dispatch for every queue (after an ack frees prefetch capacity). */
  kick(): void {
    for (const state of this.queues.values()) if (state.ready.length > 0) this.dispatch(state);
  }
}

export class InMemoryChannel implements MediaJobChannel {
  private prefetchCount = 0;
  private readonly unacked = new Map<number, string>();
  private readonly closeListeners: Array<() => void> = [];
  isClosed = false;

  constructor(private readonly broker: InMemoryMediaJobBroker) {}

  async assertQueue(queue: string): Promise<{ queue: string }> {
    return { queue: this.broker.ensureQueue(queue) };
  }

  sendToQueue(queue: string, content: Buffer, options: MediaJobPublishOptions = {}): boolean {
    if (this.isClosed) throw new Error("Channel closed");
    this.broker.publish(queue, content, options);
    return true;
  }

  async consume(queue: string, onMessage: (message: MediaJobMessage | null) => void, options: { noAck?: boolean } = {}): Promise<{ consumerTag: string }> {
    return { consumerTag: this.broker.addConsumer(queue, { noAck: options.noAck ?? false, onMessage, channel: this }) };
  }

  ack(message: MediaJobMessage): void {
    this.unacked.delete(message.fields.deliveryTag);
    this.broker.kick();
  }

  nack(message: MediaJobMessage, _allUpTo?: boolean, requeue = true): void {
    const queue = this.unacked.get(message.fields.deliveryTag);
    this.unacked.delete(message.fields.deliveryTag);
    if (requeue && queue) this.broker.requeue(queue, message);
    this.broker.kick();
  }

  async prefetch(count: number): Promise<void> {
    this.prefetchCount = count;
  }

  on(event: "close" | "error", listener: (() => void) | ((error: Error) => void)): this {
    if (event === "close") this.closeListeners.push(listener as () => void);
    return this;
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const listener of this.closeListeners) listener();
  }

  /** @internal */
  canAccept(noAck: boolean): boolean {
    return noAck || this.prefetchCount === 0 || this.unacked.size < this.prefetchCount;
  }

  /** @internal */
  track(message: MediaJobMessage, queue: string): void {
    this.unacked.set(message.fields.deliveryTag, queue);
  }
}
