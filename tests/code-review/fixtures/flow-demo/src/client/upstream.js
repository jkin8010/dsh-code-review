const PAY_URL = 'https://pay.example.com/charge';

export async function fetchJson(id) {
  const response = await fetch(`${PAY_URL}/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (!response.ok) throw new Error('charge failed');
  return response.json();
}
