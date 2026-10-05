import { connect } from "amqplib";

/**
 * The narrow slice of an AMQP channel the media-job client and the media-worker
 * consumer use. `amqplib`'s `Channel` satisfies it structurally; unit tests use an
 * in-memory implementation so no RabbitMQ is needed in CI.
 */
export type MediaJobMessage = {
  content: Buffer;
  fields: { deliveryTag: number; redelivered: boolean };
  properties: { correlationId?: string | undefined; replyTo?: string | undefined; messageId?: string | undefined; type?: string | undefined };
};

export type MediaJobPublishOptions = {
  persistent?: boolean;
  correlationId?: string;
  replyTo?: string;
  messageId?: string;
  type?: string;
  contentType?: string;
  /** Per-message TTL in ms (AMQP `expiration`), stringified on the wire. */
  expiration?: string;
};

export interface MediaJobChannel {
  assertQueue(queue: string, options?: { durable?: boolean; exclusive?: boolean; autoDelete?: boolean }): Promise<{ queue: string }>;
  sendToQueue(queue: string, content: Buffer, options?: MediaJobPublishOptions): boolean;
  consume(queue: string, onMessage: (message: MediaJobMessage | null) => void, options?: { noAck?: boolean }): Promise<{ consumerTag: string }>;
  ack(message: MediaJobMessage): void;
  nack(message: MediaJobMessage, allUpTo?: boolean, requeue?: boolean): void;
  prefetch(count: number): Promise<unknown>;
  /** Passive queue inspection (amqplib `checkQueue`): ready messages and attached consumers. Optional so minimal channel doubles keep working. */
  checkQueue?(queue: string): Promise<{ messageCount: number; consumerCount: number }>;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): Promise<void>;
}

/** Declared identically by producer and consumer (RabbitMQ rejects re-declares with different args). */
export const assertMediaJobQueue = (channel: MediaJobChannel, queue: string) => channel.assertQueue(queue, { durable: true });

export type MediaJobBrokerConnection = {
  channel: MediaJobChannel;
  /** Registers a callback fired once when the connection or channel closes/errors. */
  onClose(listener: (error?: Error) => void): void;
  close(): Promise<void>;
};

/** Opens one AMQP connection + channel. Caller owns reconnect policy. Never logs the URL (may carry credentials). */
export async function connectMediaJobBroker(url: string): Promise<MediaJobBrokerConnection> {
  const model = await connect(url);
  const channel = await model.createChannel();
  const listeners: Array<(error?: Error) => void> = [];
  let closed = false;
  const fire = (error?: Error) => {
    if (closed) return;
    closed = true;
    for (const listener of listeners) listener(error);
  };
  model.on("error", (error: Error) => fire(error));
  model.on("close", (error?: Error) => fire(error));
  channel.on("error", (error: Error) => fire(error));
  channel.on("close", () => fire());
  return {
    channel: channel as unknown as MediaJobChannel,
    onClose(listener) {
      listeners.push(listener);
    },
    async close() {
      closed = true;
      await channel.close().catch(() => undefined);
      await model.close().catch(() => undefined);
    },
  };
}

/** Strip userinfo from an AMQP URL before logging it. */
export const redactBrokerUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return "<invalid amqp url>";
  }
};
