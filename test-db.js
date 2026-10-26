
const pool = require("./src/db/pool");

async function addDemoInvoice() {
  try {
    const result = await pool.query(
      `INSERT INTO invoices
        (vendor_id, invoice_number, amount, currency,
         invoice_date, due_date, line_items, status)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING *`,
      [
        1,
        "DEMO-INV-001",
        450.00,
        "INR",
        "2026-10-26",
        "2026-11-25",
        JSON.stringify([
          { description: "Office supplies", quantity: 10, unit_price: 45 }
        ]),
       "RECEIVED"
      ]
    );

    console.log("Demo invoice created:");
    console.table(result.rows);
  } catch (error) {
    console.error("Invoice creation failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

addDemoInvoice();
