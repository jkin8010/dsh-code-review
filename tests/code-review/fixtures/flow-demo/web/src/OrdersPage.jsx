import { useEffect, useState } from 'react';

export default function OrdersPage() {
  const [orders, setOrders] = useState([]);

  useEffect(() => {
    fetch('/api/orders')
      .then((response) => response.json())
      .then((payload) => setOrders(payload.orders ?? []));
  }, []);

  return null;
}
