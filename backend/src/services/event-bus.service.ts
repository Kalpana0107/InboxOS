import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/0';

export class EventBus {
  private static pubClient: Redis | null = null;
  private static subClient: Redis | null = null;
  private static subHandlers: Map<string, Array<(payload: any) => void>> = new Map();

  /**
   * Initializes the Redis publish client connection.
   */
  private static getPubClient(): Redis {
    if (!this.pubClient) {
      this.pubClient = new Redis(REDIS_URL, {
        maxRetriesPerRequest: null,
      });

      this.pubClient.on('error', (error) => {
        console.error('Redis Pub Client Error:', error);
      });

      this.pubClient.on('connect', () => {
        console.log('Redis Pub Client Connected');
      });
    }
    return this.pubClient;
  }

  /**
   * Initializes the Redis subscribe client connection.
   */
  private static getSubClient(): Redis {
    if (!this.subClient) {
      this.subClient = new Redis(REDIS_URL, {
        maxRetriesPerRequest: null,
      });

      this.subClient.on('error', (error) => {
        console.error('Redis Sub Client Error:', error);
      });

      this.subClient.on('connect', () => {
        console.log('Redis Sub Client Connected');
      });

      // Set up global message dispatcher for the subscriber connection
      this.subClient.on('message', (channel, message) => {
        try {
          const payload = JSON.parse(message);
          const handlers = this.subHandlers.get(channel);
          if (handlers) {
            handlers.forEach((handler) => {
              try {
                handler(payload);
              } catch (handlerError) {
                console.error(`Error in event handler for channel ${channel}:`, handlerError);
              }
            });
          }
        } catch (parseError) {
          console.error(`Error parsing message on channel ${channel}:`, parseError);
        }
      });
    }
    return this.subClient;
  }

  /**
   * Publishes a structured JSON payload to a Redis Pub/Sub topic.
   */
  public static async publish(topic: string, payload: any): Promise<void> {
    try {
      const client = this.getPubClient();
      const message = JSON.stringify(payload);
      await client.publish(topic, message);
    } catch (error) {
      console.error(`Failed to publish event to topic "${topic}":`, error);
      throw error;
    }
  }

  /**
   * Subscribes to a Redis Pub/Sub topic and runs the handler on received messages.
   */
  public static async subscribe(topic: string, handler: (payload: any) => void): Promise<void> {
    try {
      const client = this.getSubClient();
      
      // Store handler
      let handlers = this.subHandlers.get(topic);
      if (!handlers) {
        handlers = [];
        this.subHandlers.set(topic, handlers);
        // Subscribe the Redis client to the topic channel
        await client.subscribe(topic);
      }
      handlers.push(handler);
    } catch (error) {
      console.error(`Failed to subscribe to topic "${topic}":`, error);
      throw error;
    }
  }

  /**
   * Cleanly disconnects client connections.
   */
  public static async disconnect(): Promise<void> {
    if (this.pubClient) {
      await this.pubClient.quit();
      this.pubClient = null;
    }
    if (this.subClient) {
      await this.subClient.quit();
      this.subClient = null;
    }
    this.subHandlers.clear();
  }
}
