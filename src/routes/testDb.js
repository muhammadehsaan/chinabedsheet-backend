const express = require("express");

const { asyncHandler } = require("../utils/async");
const { pool } = require("../db-pg");

const router = express.Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT NOW() AS time");
      res.json({ time: rows[0].time });
    } catch (error) {
      error.statusCode = 500;
      error.message = "Failed to connect to PostgreSQL";
      throw error;
    }
  })
);

module.exports = router;
