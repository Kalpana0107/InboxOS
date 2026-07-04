import request from 'supertest';
import { app, server, prisma } from '../server';
import { EventBus } from '../services/event-bus.service';

describe('GET /api/health', () => {
  afterAll(async () => {
    // Clean up server resources, db client and event bus to allow Jest to exit cleanly
    server.close();
    await prisma.$disconnect();
    await EventBus.disconnect();
  });

  it('should return 200 OK and status ok with timestamp', async () => {
    const res = await request(app).get('/api/health').expect(200);

    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['strict-transport-security']).toContain(
      'max-age=31536000'
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');

    // Validate that timestamp is a valid ISO date string
    const date = new Date(res.body.timestamp);
    expect(date.getTime()).not.toBeNaN();
  });

  it('allows configured development origins', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173'
    );
  });

  it('rejects origins outside the allowlist', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'https://attacker.example')
      .expect(403);

    expect(res.body).toEqual({ error: 'Origin not allowed' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
