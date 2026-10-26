
const pool = require("./src/db/pool");

async function createTestInvoice() {
  try {
    const result = await pool.query(
      `INSERT INTO invoices
        (vendor_id, invoice_number, amount, currency,
         line_items, status)
       VALUES
        ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING invoice_id, invoice_number, amount, currency, status`,
      [
        1,
        "DEMO-INV-002",
        650.00,
        "INR",
        JSON.stringify([
          {
            description: "Test supplies",
            quantity: 1,
            unit_price: 650
          }
        ]),
        "RECEIVED"
      ]
    );

    console.table(result.rows);
  } catch (error) {
    console.error("Test invoice creation failed:", error.message);
  } finally {
    await pool.end();
  }
}

createTestInvoice();
