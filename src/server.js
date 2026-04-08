require("dotenv").config();

const { app } = require("./app");

const PORT = Number(process.env.PORT || 5000);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend running on http://localhost:${PORT}`);
});
