const errorHandler = (err, req, res, next) => {
  const status = err.statusCode || 500;
  const message = err.message || "Server error";
  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.error(err);
  }
  res.status(status).json({ message, details: err.details || [] });
};

module.exports = { errorHandler };
