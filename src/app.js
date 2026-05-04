const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const { errorHandler } = require("./middleware/error");
const inventoryRoutes = require("./routes/inventory");
const purchasesRoutes = require("./routes/purchases");
const salesRoutes = require("./routes/sales");
const partiesRoutes = require("./routes/parties");
const reportsRoutes = require("./routes/reports");
const accountsRoutes = require("./routes/accounts");
const productionRoutes = require("./routes/production");
const emiRoutes = require("./routes/emi");
const logisticsRoutes = require("./routes/logistics");
const authRoutes = require("./routes/auth");
const rbacRoutes = require("./routes/rbac");
const dealsRoutes = require("./routes/deals");
const testDbRoutes = require("./routes/testDb");
const { authRequired } = require("./middleware/auth");

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(morgan("dev"));

app.get("/", (req, res) => {
  res.send("API Working");
});

app.get("/api/v1/health", (req, res) => {
  res.json({ status: "ok", service: "china-bedsheet-erp-backend" });
});

app.use("/test-db", testDbRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/inventory", authRequired, inventoryRoutes);
app.use("/api/v1/purchases", authRequired, purchasesRoutes);
app.use("/api/v1/sales", authRequired, salesRoutes);
app.use("/api/v1/parties", authRequired, partiesRoutes);
app.use("/api/v1/reports", authRequired, reportsRoutes);
app.use("/api/v1/accounts", authRequired, accountsRoutes);
app.use("/api/v1/production", authRequired, productionRoutes);
app.use("/api/v1/emi", authRequired, emiRoutes);
app.use("/api/v1/logistics", authRequired, logisticsRoutes);
app.use("/api/v1/rbac", authRequired, rbacRoutes);
app.use("/api/v1/deals", authRequired, dealsRoutes);

app.use(errorHandler);

module.exports = { app };
