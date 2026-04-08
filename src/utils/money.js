const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const round3 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 1000) / 1000;

const calcLineTotals = (quantity, unitCost, gstPercent) => {
  const qty = round3(quantity);
  const cost = round2(unitCost);
  const gst = round2(gstPercent);
  const base = round2(qty * cost);
  const tax = round2((base * gst) / 100);
  const total = round2(base + tax);
  return { base, tax, total };
};

module.exports = { round2, round3, calcLineTotals };
