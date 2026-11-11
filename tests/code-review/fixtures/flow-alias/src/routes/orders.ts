import { Router } from 'express';
import { createOrder } from '@/services/order';

const router = Router();

router.post('/api/alias-orders', async (req, res) => {
  const order = await createOrder(req.body);
  res.json({ ok: true, order });
});

export default router;
