
const pool = require("./src/db/pool");

async function updateCurrency() {
  try {
    const result = await pool.query(
      `UPDATE invoices
       SET currency = $1
       WHERE invoice_id = $2
       RETURNING invoice_id, invoice_number, amount, currency`,
      ["INR", 3]
    );

    console.table(result.rows);
  } catch (error) {
    console.error("Update failed:", error.message);
  } finally {
    await pool.end();
  }
}

updateCurrency();

