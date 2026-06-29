import { EventBus } from './services/event-bus.service';

async function main() {
  console.log('Worker starting...');

  // Subscribe to 'email.received' topic
  await EventBus.subscribe('email.received', (payload) => {
    console.log(`[Worker] Received email.received event! emailId: ${payload.emailId}`);
  });

  console.log('Worker is listening for email.received events...');
}

main().catch((error) => {
  console.error('Worker failed to start:', error);
  process.exit(1);
});
