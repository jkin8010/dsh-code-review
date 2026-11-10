export function authGuard(req, res, next) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function roleGuard(role) {
  return (req, res, next) => {
    if (req.user?.role === role) next();
    else res.status(403).json({ error: 'forbidden' });
  };
}
