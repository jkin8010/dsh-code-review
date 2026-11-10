export function requestLogger(req, res, next) {
  const startedAt = Date.now();
  res.on('finish', () => {
    const elapsed = Date.now() - startedAt;
    record(`${req.method} ${req.path} ${res.statusCode} ${elapsed}ms`);
  });
  next();
}

function record(line) {
  process.stdout.write(`${line}\n`);
}
