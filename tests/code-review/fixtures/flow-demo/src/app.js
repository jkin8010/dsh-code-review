import express from 'express';
import { createOrder } from './service/orderService.js';
import { getUser } from './service/userService.js';

const app = express();
app.use(express.json());

app.post('/api/orders', async (req, res) => {
  const body = req.body;
  console.log('incoming token', req.headers.authorization);
  try {
    const order = await createOrder(body);
    res.json({ ok: true, order });
  } catch (error) {
    console.log('create order failed', error);
  }
});

app.get('/api/users/:id', async (req, res) => {
  const user = await getUser(req.params.id);
  res.json({ ok: true, user });
});

export default app;
